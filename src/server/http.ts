import http from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import {
  AuthorizationError,
  canManageTokensFor,
  DEFAULT_AGENT_SCOPES,
  isTokenScope,
  require as requireCapability,
  TOKEN_SCOPES,
  type Capability,
  type TokenScope,
} from "../auth/authorize.ts";
import { claimIssue, ClaimError, holdsClaimOn } from "../domain/claim.ts";
import {
  endRun, findRun, heartbeatRun, listRunsFor, RunError, startRun, type RunRecord,
} from "../domain/run.ts";
import { RuntimeStore, type Claim } from "../storage/runtime.ts";
import {
  CredentialStore,
  TOKEN_DEFAULT_TTL_MS,
  type TokenRecord,
} from "../auth/credentials.ts";
import { createIssue, ISSUE_TYPES, IssueError } from "../domain/issue.ts";
import {
  addLink,
  ChildrenPresentError,
  deleteIssue,
  removeLink,
  IMMUTABLE_FIELDS,
  PreconditionFailedError,
  PreconditionRequiredError,
  QuarantinedError,
  transitionIssue,
  TransitionError,
  updateIssue,
  type DeleteStrategy,
} from "../domain/update.ts";
import {
  authenticate,
  changeRole,
  createUser,
  listUsers,
  needsBootstrap,
  UserError,
  type Role,
  type UserRecord,
} from "../domain/users.ts";
import { buildEvent, redact } from "../domain/events.ts";
import { allowedTargets, isStatus, requiresAdmin, STATUSES } from "../domain/transition.ts";
import { activityOf, lastActorKinds } from "../domain/activity.ts";
import { childrenOf } from "../domain/hierarchy.ts";
import { claimability, relatedTo } from "../domain/links.ts";
import {
  createSprint,
  deleteSprint,
  findSprint,
  listSprints,
  closeSprint,
  planOf,
  SprintConflictError,
  SprintNotEmptyError,
  SprintStateError,
  startSprint,
  updateSprint,
} from "../domain/sprint.ts";
import {
  isRankField,
  moveIssue,
  NeighboursMovedError,
  orderedRegion,
} from "../domain/ordering.ts";
import { RankSpaceExhausted } from "../domain/rank.ts";
import { canonicalJson, type JsonValue } from "../storage/jcs.ts";
import {
  findIssue,
  indexStatus,
  listIssues,
  openBoardForWriting,
  type BoardHandle,
  type WritableBoard,
} from "../storage/board.ts";
import { reconcileExternal, reconcileFull } from "../storage/external.ts";
import { boardHealth, quarantineList } from "../storage/integrity.ts";
import { gitStatus } from "../storage/git-status.ts";
import { findTombstone, type ReconcileReason } from "../storage/reconcile.ts";
import { watchBoard, type BoardWatcher } from "../storage/watcher.ts";
import { formatEtag } from "../storage/resource.ts";
import { EventStream } from "./stream.ts";

export const SESSION_COOKIE = "localjira_session";

export interface ServerOptions {
  cwd: string;
  host?: string;
  port?: number;
  /** Off in tests that drive reconciliation by hand. */
  watch?: boolean;
  debounceMs?: number;
}

export interface RunningServer {
  url: string;
  port: number;
  /** Reconciles now instead of waiting for the debounce window. */
  reconcile(): Promise<void>;
  close(): Promise<void>;
}

interface RequestContext {
  writable: WritableBoard;
  board: BoardHandle;
  store: CredentialStore;
  runtime: RuntimeStore;
  stream: EventStream;
  user: UserRecord | null;
  /** Set when a PAT authenticated this request rather than a browser session. */
  token?: TokenRecord | null;
  reconcile(reason?: ReconcileReason | null): Promise<void>;
  /** False when the write queue waited out its limit and should 503. */
  awaitWriteGate(): Promise<boolean>;
  closeWriteGate(running: Promise<void>): Promise<void>;
  indexBusy(): boolean;
}

const WEB_ASSETS = new Map([
  ["/", { file: "../web/index.html", type: "text/html; charset=utf-8" }],
  ["/app.css", { file: "../web/app.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "../web/app.js", type: "text/javascript; charset=utf-8" }],
] as const);

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  // Acquiring the writer lock here is what makes a second server refuse to
  // start rather than interleave writes with this one (ADR-002).
  const writable = await openBoardForWriting(options.cwd);
  const board = writable.board;
  const store = new CredentialStore(board.localDirectory);
  store.purgeExpired();

  // §5.4: a restart reclaims expired claims in full and keeps the rest. A
  // server restarting must not cost a working agent its place, and a lease that
  // ran out while nothing was watching must not survive as a ghost.
  const runtime = new RuntimeStore(board.localDirectory);
  const reclaimed = runtime.reclaimExpired();
  if (reclaimed > 0) {
    process.stderr.write(`localjira: reclaimed ${reclaimed} expired claim(s)\n`);
  }

  // After the replay, so "did this key produce anything" is answered against a
  // finished journal. A reservation that never reached the journal is released;
  // one that did is kept, because the resource it names now exists and a retry
  // must be answered from it rather than creating a second (r15 AC10).
  writable.outbox.purgeIdempotency();
  const orphans = writable.outbox.resolveOrphanedIdempotency();
  if (orphans.released > 0 || orphans.kept > 0) {
    process.stderr.write(
      `localjira: ${orphans.released} idempotency key(s) released, ` +
        `${orphans.kept} kept for a write that landed\n`,
    );
  }

  if (writable.replay.replayed > 0) {
    process.stderr.write(
      `localjira: replayed ${writable.replay.replayed} unfinished write(s) ` +
        `(${writable.replay.rolledForward} rolled forward, ${writable.replay.aborted} abandoned)\n`,
    );
  }

  const stream = new EventStream();

  // Reconciliation is serialised: two overlapping scans would race on the same
  // index rows, and the watcher can easily fire again while one is running.
  let reconciling: Promise<void> = Promise.resolve();

  // What the last announcement said, so the stream carries a change rather than
  // a heartbeat. Read from the index after every pass instead of threaded out
  // of the reconcile: both the incremental and the full path can release or
  // create a quarantine, and only one of them returns a report.
  /**
   * Held shut while the index generation is swapped.
   *
   * Queued rather than refused, so an ordinary write during a rebuild waits a
   * moment instead of failing — but bounded, because a caller blocked with no
   * end in sight is worse than one told to come back (설계 §3.7). A verify does
   * not touch this: it only reads and reports.
   */
  let writeGate: Promise<void> | null = null;
  const WRITE_QUEUE_LIMIT_MS = 30_000;

  const awaitWriteGate = async (): Promise<boolean> => {
    if (writeGate === null) {
      return true;
    }
    const timedOut = Symbol("timeout");
    const timer = new Promise<typeof timedOut>((resolve) => {
      setTimeout(() => resolve(timedOut), WRITE_QUEUE_LIMIT_MS).unref?.();
    });
    return (await Promise.race([writeGate, timer])) !== timedOut;
  };

  let announcedIntegrity = "";
  const announceIntegrity = (): void => {
    const health = boardHealth(board.db);
    const count = quarantineList(board.db).length;
    const summary = `${count}|${health.sprintConflicts.join(",")}`;
    if (summary === announcedIntegrity) {
      return;
    }
    announcedIntegrity = summary;
    stream.publish({
      type: "integrity.changed",
      data: { quarantined: count, sprintConflicts: health.sprintConflicts },
    });
  };
  const reconcile = (escalation: ReconcileReason | null = null): Promise<void> => {
    reconciling = reconciling.then(async () => {
      const result =
        escalation === null
          ? await reconcileExternal(writable)
          : await reconcileFull(writable, escalation);

      for (const change of result.changed) {
        stream.publish({
          type: "issue.changed",
          data: { key: change.key, uid: change.uid, path: change.path, source: "external" },
        });
      }
      if (result.removed > 0) {
        stream.publish({ type: "index.state", data: { removed: result.removed } });
      }

      if ("report" in result) {
        const { report } = result;
        // A full pass is rare and expensive, so it says why it ran and what it
        // cost. Without the reason a log of these is unreadable: they all look
        // the same and none of them explain themselves.
        process.stdout.write(
          `localjira: reconciled (${report.reason}) — scanned ${report.scanned}, ` +
            `hashed ${report.hashed}, changed ${report.changed.length}, ` +
            `moved ${report.renamed.length}, tombstoned ${report.tombstoned.length}, ` +
            `deleted ${report.confirmed.length}, ${report.durationMs}ms\n`,
        );
        for (const moved of report.renamed) {
          stream.publish({
            type: "issue.changed",
            data: { key: moved.key, uid: moved.uid, path: moved.to, source: "moved" },
          });
        }
      }

      announceIntegrity();
    }, () => undefined);
    return reconciling;
  };

  // Startup is a full pass: whatever happened while the server was down left no
  // events behind, and a pull or a branch switch is exactly what tends to
  // happen in that window.
  await reconcile("startup");

  let watcher: BoardWatcher | null = null;
  if (options.watch !== false) {
    watcher = watchBoard(board.boardRoot, {
      debounceMs: options.debounceMs,
      onBatch: (_paths, escalation) => void reconcile(escalation),
      onError: (error) =>
        process.stderr.write(`localjira: watcher error: ${error.message}\n`),
    });
  }

  const server = http.createServer((request, response) => {
    handle(request, response, {
      writable, board, store, runtime, stream, user: null,
      reconcile, awaitWriteGate,
      closeWriteGate: (running: Promise<void>) => {
        writeGate = running.finally(() => {
          writeGate = null;
        });
        return writeGate;
      },
      indexBusy: () => writeGate !== null,
    }).catch((error) => {
      respondError(response, 500, "E_INTERNAL", describe(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  // Closing twice is easy to do — a test that closes explicitly and also
  // registers a cleanup hook, for instance. http.Server does not invoke the
  // callback the second time, so without memoising this the second await
  // never settles.
  let closing: Promise<void> | null = null;

  return {
    url: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
    port: address.port,
    reconcile: () => {
      watcher?.flush();
      return reconcile();
    },
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        watcher?.close();
        stream.close();
        server.closeAllConnections?.();
        server.close(() => {
          store.close();
          runtime.close();
          void writable.close().then(resolve);
        });
      });
      return closing;
    },
  };
}

async function handle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const route = `${request.method} ${url.pathname}`;

  if (request.method === "GET" && WEB_ASSETS.has(url.pathname)) {
    return serveWebAsset(url.pathname, response);
  }

  if (route === "POST /auth/login") {
    return login(request, response, context);
  }
  if (route === "POST /auth/logout") {
    return logout(request, response, context);
  }

  // A domain write during a rebuild waits for the generation swap rather than
  // failing — but not forever. Past the limit the honest answer is "come back",
  // with a Retry-After, instead of a request that never returns (설계 §3.7).
  if (request.method !== "GET" && !url.pathname.startsWith("/auth/")) {
    if (!(await context.awaitWriteGate())) {
      response.setHeader("Retry-After", "30");
      return respondError(
        response, 503, "E_INDEX_REBUILDING",
        "The index is being rebuilt and the write queue is full.",
        "Try again in a moment.",
      );
    }
  }

  // Everything below is a domain route, so it needs an authenticated actor.
  const actor = resolveActor(request, context);
  const user = actor?.user ?? null;
  if (!user) {
    return respondError(
      response,
      401,
      needsBootstrap(context.board) ? "E_BOOTSTRAP_REQUIRED" : "E_UNAUTHENTICATED",
      needsBootstrap(context.board)
        ? "This board has no accounts yet. Create the first admin with: localjira admin create"
        : "Sign in first.",
    );
  }
  const authed: RequestContext = { ...context, user, token: actor!.token };

  // Before any route runs: a token bound to one project must not reach another
  // project's data, and refusing here rather than inside each handler is what
  // keeps a new route from being the exception (D9).
  const trespass = projectTrespass(request, url, authed);
  if (trespass !== null) {
    await recordDenial(authed, {
      capability: "issue:read",
      scope: null,
      role: user.role,
      project: trespass,
    });
    return respondError(
      response, 403, "E_PROJECT_SCOPE",
      `This token is scoped to ${authed.token!.projectScope} and may not reach ${trespass}.`,
    );
  }

  if (route === "GET /stream") {
    const token = sessionToken(request)!;
    const session = context.store.touchSession(token);
    if (!session) {
      return respondError(response, 401, "E_UNAUTHENTICATED", "Sign in first.");
    }
    return context.stream.attach(request, response, {
      key: streamSessionKey(token),
      expiresAt: session.expiresAt,
    });
  }
  if (route === "GET /me") {
    return respondJson(response, 200, { user });
  }
  if (route === "GET /users") {
    return respondJson(response, 200, { users: listUsers(context.board) });
  }
  if (route === "POST /users") {
    return createUserRoute(request, response, authed);
  }
  if (request.method === "PUT" && /^\/users\/[^/]+\/role$/.test(url.pathname)) {
    return changeRoleRoute(
      decodeURIComponent(url.pathname.slice("/users/".length, -"/role".length)),
      request,
      response,
      authed,
    );
  }
  if (route === "GET /runs") {
    return guard(response, authed, "issue:read", "issue:read", () =>
      listRunsRoute(url, response, authed),
    );
  }
  if (route === "POST /runs") {
    return guard(response, authed, "issue:write", "run:write", () =>
      withIdempotency(request, response, authed, (idempotency) =>
        startRunRoute(request, response, authed, idempotency),
      ),
    );
  }
  const heartbeat = /^\/runs\/([^/]+)\/heartbeat$/.exec(url.pathname);
  if (heartbeat && request.method === "POST") {
    return guard(response, authed, "issue:write", "run:write", () =>
      heartbeatRoute(decodeURIComponent(heartbeat[1]), response, authed),
    );
  }
  const runEnd = /^\/runs\/([^/]+)\/end$/.exec(url.pathname);
  if (runEnd && request.method === "POST") {
    return guard(response, authed, "issue:write", "run:write", () =>
      endRunRoute(decodeURIComponent(runEnd[1]), request, response, authed),
    );
  }
  const runItem = /^\/runs\/([^/]+)$/.exec(url.pathname);
  if (runItem && request.method === "GET") {
    return guard(response, authed, "issue:read", "issue:read", () => {
      const run = findRun(authed.board, decodeURIComponent(runItem[1]));
      if (run === null) {
        return respondError(response, 404, "E_UNKNOWN_RUN", "No such run.");
      }
      respondJson(response, 200, {
        ...runView(run),
        claim: claimView(authed.runtime.findByRun(run.runId)),
      });
    });
  }

  if (route === "GET /tokens") {
    return listTokensRoute(response, authed);
  }
  if (route === "POST /tokens") {
    return createTokenRoute(request, response, authed);
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/tokens/")) {
    return revokeTokenRoute(
      decodeURIComponent(url.pathname.slice("/tokens/".length)),
      response,
      authed,
    );
  }
  if (route === "GET /issues") {
    return guard(response, authed, "issue:read", "issue:read", () =>
      listIssuesRoute(url, response, authed),
    );
  }
  if (route === "POST /issues") {
    return guard(response, authed, "issue:write", "issue:edit", () =>
      withIdempotency(request, response, authed, (idempotency) =>
        createIssueRoute(request, response, authed, idempotency),
      ),
    );
  }
  if (request.method === "POST" && url.pathname.endsWith("/claim")) {
    const key = decodeURIComponent(url.pathname.slice("/issues/".length, -"/claim".length));
    // `issue:transition` rather than a scope of its own: claiming is how an
    // agent gets permission to move an issue, so a token that may not move one
    // has no use for a claim (§6.4 fixes the seven).
    return guard(response, authed, "issue:write", "issue:transition", () =>
      claimRoute(key, request, response, authed),
    );
  }
  if (request.method === "POST" && url.pathname.endsWith("/transitions")) {
    const key = decodeURIComponent(
      url.pathname.slice("/issues/".length, -"/transitions".length),
    );
    return guard(response, authed, "issue:write", "issue:transition", () =>
      transitionRoute(key, request, response, authed),
    );
  }
  if (request.method === "POST" && url.pathname.endsWith("/rank")) {
    const key = decodeURIComponent(url.pathname.slice("/issues/".length, -"/rank".length));
    // Its own capability, not `issue:write`: an agent may edit an issue without
    // being allowed to decide what the team works on next (D9).
    return guard(response, authed, "issue:rank", "issue:rank", () =>
      rankRoute(key, request, response, authed),
    );
  }
  if (request.method === "POST" && url.pathname.endsWith("/links")) {
    const key = decodeURIComponent(url.pathname.slice("/issues/".length, -"/links".length));
    return guard(response, authed, "issue:write", "issue:edit", () =>
      addLinkRoute(key, request, response, authed),
    );
  }
  if (request.method === "DELETE" && url.pathname.includes("/links/")) {
    const [key, id] = url.pathname
      .slice("/issues/".length)
      .split("/links/")
      .map((part) => decodeURIComponent(part));
    return guard(response, authed, "issue:write", "issue:edit", () =>
      removeLinkRoute(key, id, request, response, authed),
    );
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/issues/")) {
    return guard(response, authed, "issue:delete", "issue:delete", () =>
      deleteRoute(
        decodeURIComponent(url.pathname.slice("/issues/".length)),
        request,
        response,
        authed,
      ),
    );
  }
  if (
    (request.method === "PUT" || request.method === "PATCH") &&
    url.pathname.startsWith("/issues/")
  ) {
    return guard(response, authed, "issue:write", "issue:edit", () =>
      updateIssueRoute(
        decodeURIComponent(url.pathname.slice("/issues/".length)),
        request,
        response,
        authed,
      ),
    );
  }
  if (request.method === "GET" && url.pathname.startsWith("/issues/")) {
    const rest = decodeURIComponent(url.pathname.slice("/issues/".length));
    if (rest.endsWith("/children")) {
      return childrenRoute(rest.slice(0, -"/children".length), response, authed);
    }
    if (rest.endsWith("/links")) {
      return linksRoute(rest.slice(0, -"/links".length), response, authed);
    }
    if (rest.endsWith("/activity")) {
      return activityRoute(rest.slice(0, -"/activity".length), url, response, authed);
    }
    return showIssueRoute(rest, response, authed);
  }
  if (route === "GET /rekeys") {
    return guard(response, authed, "issue:read", "issue:read", () => {
      // Read from the event log rather than a table: a rekey is a thing that
      // happened, and the events are the record of what happened (§5.3).
      const rows = authed.board.db
        .prepare(
          `SELECT at, target_uid, before_json, after_json, detail_json FROM events
            WHERE verb = 'issue.rekeyed' ORDER BY at DESC, event_id DESC LIMIT 200`,
        )
        .all() as Array<{
        at: string;
        target_uid: string;
        before_json: string | null;
        after_json: string | null;
        detail_json: string | null;
      }>;

      respondJson(response, 200, {
        rekeys: rows.map((row) => ({
          at: row.at,
          uid: row.target_uid,
          from: JSON.parse(row.before_json ?? "{}").key ?? null,
          to: JSON.parse(row.after_json ?? "{}").key ?? null,
          reason: JSON.parse(row.detail_json ?? "{}").reason ?? null,
        })),
      });
    });
  }
  // ── sprints (r05a) ────────────────────────────────────────────────────
  const sprintCollection = /^\/projects\/([^/]+)\/sprints$/.exec(url.pathname);
  if (sprintCollection && request.method === "GET") {
    return guard(response, authed, "issue:read", "issue:read", () => {
      const status = url.searchParams.get("status");
      respondJson(response, 200, {
        sprints: listSprints(authed.board, decodeURIComponent(sprintCollection[1]), status ?? undefined),
      });
    });
  }
  if (sprintCollection && request.method === "POST") {
    return guard(response, authed, "sprint:write", null, () =>
      createSprintRoute(decodeURIComponent(sprintCollection[1]), request, response, authed),
    );
  }

  const boardRoute = /^\/projects\/([^/]+)\/board$/.exec(url.pathname);
  if (boardRoute && request.method === "GET") {
    return guard(response, authed, "issue:read", "issue:read", () =>
      respondBoard(decodeURIComponent(boardRoute[1]), response, authed),
    );
  }

  const sprintCommand = /^\/sprints\/([^/]+)\/(start|close)$/.exec(url.pathname);
  if (sprintCommand && request.method === "POST") {
    const id = decodeURIComponent(sprintCommand[1]);
    return guard(response, authed, "sprint:write", null, () =>
      sprintCommand[2] === "start"
        ? startSprintRoute(id, response, authed)
        : closeSprintRoute(id, request, response, authed),
    );
  }

  const sprintPlan = /^\/sprints\/([^/]+)\/plan$/.exec(url.pathname);
  if (sprintPlan && request.method === "GET") {
    return guard(response, authed, "issue:read", "issue:read", () => {
      const plan = planOf(authed.board, decodeURIComponent(sprintPlan[1]));
      if (plan === null) {
        return respondError(response, 404, "E_SPRINT_NOT_FOUND", "No such sprint.");
      }
      respondJson(response, 200, plan);
    });
  }

  const sprintIssues = /^\/sprints\/([^/]+)\/issues$/.exec(url.pathname);
  if (sprintIssues && request.method === "POST") {
    return guard(response, authed, "issue:write", "issue:edit", () =>
      moveIssuesRoute(decodeURIComponent(sprintIssues[1]), request, response, authed),
    );
  }

  const sprintItem = /^\/sprints\/([^/]+)$/.exec(url.pathname);
  if (sprintItem) {
    const id = decodeURIComponent(sprintItem[1]);
    if (request.method === "GET") {
      return guard(response, authed, "issue:read", "issue:read", () => {
        const sprint = findSprint(authed.board, id);
        if (sprint === null) {
          return respondError(response, 404, "E_SPRINT_NOT_FOUND", `No sprint with id ${id}`);
        }
        respondResource(response, 200, sprint.resource as JsonValue, sprint.etag);
      });
    }
    if (request.method === "PATCH") {
      return guard(response, authed, "sprint:write", null, () =>
        updateSprintRoute(id, request, response, authed),
      );
    }
    if (request.method === "DELETE") {
      return guard(response, authed, "sprint:write", null, () =>
        deleteSprintRoute(id, request, response, authed),
      );
    }
  }

  if (route === "GET /git/status") {
    return guard(response, authed, "issue:read", "issue:read", () => {
      // Read-only, and local-only: N4 says the tool works offline, so nothing
      // here fetches. D4 says the service never commits or pushes, so there is
      // no companion endpoint that would.
      respondJson(response, 200, gitStatus(authed.board.boardRoot));
    });
  }
  if (route === "GET /index") {
    return guard(response, authed, "issue:read", "issue:read", () => {
      respondJson(response, 200, indexReport(authed));
    });
  }
  if (route === "POST /index/rebuild") {
    return guard(response, authed, "index:rebuild", null, () => rebuildRoute(response, authed));
  }
  if (route === "POST /index/verify") {
    return guard(response, authed, "index:verify", null, () => verifyRoute(response, authed));
  }
  if (route === "GET /integrity/issues") {
    return guard(response, authed, "issue:read", "issue:read", () => {
      const health = boardHealth(authed.board.db);
      respondJson(response, 200, {
        quarantined: quarantineList(authed.board.db),
        // Not quarantined, but the board cannot act on them either: two active
        // sprints is a rule violation no merge can settle, and duplicate ranks
        // sort fine but want rebalancing (ADR-005 §1).
        sprintConflicts: health.sprintConflicts,
        duplicateRankRegions: health.duplicateRanks,
      });
    });
  }

  respondError(response, 404, "E_NOT_FOUND", `No route for ${route}`);
}

function serveWebAsset(pathname: string, response: http.ServerResponse): void {
  const asset = WEB_ASSETS.get(pathname);
  if (!asset) {
    return respondError(response, 404, "E_NOT_FOUND", "Not found.");
  }

  const body = fs.readFileSync(fileURLToPath(new URL(asset.file, import.meta.url)));
  response.writeHead(200, {
    "Content-Type": asset.type,
    "Content-Length": body.byteLength,
    "Cache-Control": "no-cache",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(body);
}

async function login(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const body = await readJson(request);
  const id = typeof body.id === "string" ? body.id : "";
  const password = typeof body.password === "string" ? body.password : "";

  const outcome = authenticate(context.board, context.store, id, password);
  if (!outcome.user) {
    // One message for every failure. Naming the cause would let a caller
    // enumerate accounts, and "no credentials on this device" is only shown
    // where the operator can already see the board (the CLI).
    return respondError(response, 401, "E_INVALID_CREDENTIALS", "Invalid id or password.");
  }

  const session = context.store.createSession(outcome.user.id);
  response.setHeader("Set-Cookie", cookie(session.token, session.expiresAt));
  respondJson(response, 200, { user: outcome.user });
}

async function logout(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const token = sessionToken(request);
  if (token) {
    context.store.destroySession(token);
    context.stream.disconnect(streamSessionKey(token));
  }
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
  respondJson(response, 200, { ok: true });
}

function listIssuesRoute(
  url: URL,
  response: http.ServerResponse,
  context: RequestContext,
): void {
  const many = (name: string): string[] | undefined => {
    const values = url.searchParams.getAll(name).flatMap((value) => value.split(","));
    const cleaned = values.map((value) => value.trim()).filter((value) => value !== "");
    return cleaned.length > 0 ? cleaned : undefined;
  };

  const status = many("status");
  const type = many("type");
  const sprint = many("sprint");

  // Rejected rather than quietly matched against nothing. `sprint=active` is
  // the form §4 S3 uses, and answering it with an empty list would read as
  // "no work available" instead of "sprints do not exist yet" (r05, M2).
  if (sprint?.includes("active")) {
    return respondError(
      response, 400, "E_FILTER_UNSUPPORTED",
      "sprint=active is not available yet.",
      "Sprint entities arrive with r05 (M2). Filter by a sprint id in the meantime.",
    );
  }

  const badStatus = status?.filter((value) => !STATUSES.includes(value.toUpperCase() as never));
  if (badStatus && badStatus.length > 0) {
    return respondError(
      response, 400, "E_INVALID_FILTER",
      `Not a status: ${badStatus.join(", ")}.`,
      `Allowed: ${STATUSES.join(", ")}.`,
    );
  }

  const badType = type?.filter((value) => !ISSUE_TYPES.includes(value.toLowerCase() as never));
  if (badType && badType.length > 0) {
    return respondError(
      response, 400, "E_INVALID_FILTER",
      `Not an issue type: ${badType.join(", ")}.`,
      `Allowed: ${ISSUE_TYPES.join(", ")}.`,
    );
  }

  const claimable = url.searchParams.get("claimable");
  if (claimable !== null && claimable !== "true" && claimable !== "false") {
    return respondError(
      response, 400, "E_INVALID_FILTER",
      `claimable must be true or false, not "${claimable}".`,
    );
  }

  const query = url.searchParams.get("q");
  const cursor = url.searchParams.get("after");
  // A project-scoped token gets its own project, not a refusal: a collection
  // names no project, and an agent asking what work exists should be answered
  // rather than told off (S3-D9). Overriding rather than merging, so asking for
  // another project returns that project's nothing instead of everything.
  const bound = context.token?.projectScope ?? null;
  const page = listIssues(context.board, {
    project: bound ?? url.searchParams.get("project") ?? undefined,
    status,
    type,
    assignee: many("assignee"),
    label: many("label"),
    sprint,
    // Blank means "no search", not a bad request: a cleared search box should
    // show the list again rather than an error.
    q: url.searchParams.get("q") ?? undefined,
    claimable: claimable === "true" ? true : undefined,
    limit: url.searchParams.has("limit")
      ? Number(url.searchParams.get("limit"))
      : undefined,
    after: parseCursor(cursor),
  });

  // Claims live in `.local/runtime.sqlite`, a different database from the index,
  // so this cannot be a join. Applied after the page rather than by attaching
  // that file, because the index is rebuilt into a fresh database and an ATTACH
  // would make the disposable one depend on the other's presence. The cost is
  // that a page may come back shorter than its limit; the number of live claims
  // is one per working agent, so that is a small cost for AC9's promise that a
  // claimable list holds nothing already taken.
  const issues =
    claimable === "true"
      ? page.issues.filter(
          (issue) =>
            context.runtime.find(issue.uid) === null &&
            (issue.status === "TODO" || issue.status === "IN_PROGRESS"),
        )
      : page.issues;

  // The badge shows who touched a card last, which is not the same as who
  // created it: without this an agent's change is indistinguishable from the
  // human creation underneath it (§5.1, §8).
  const kinds = lastActorKinds(context.board, issues.map((issue) => issue.uid));
  respondJson(response, 200, {
    issues: issues.map(({ createdByKind, ...issue }) => ({
      ...issue,
      created_by_kind: createdByKind,
      last_actor_kind: kinds.get(issue.uid) ?? null,
    })),
    hasMore: page.hasMore,
    nextAfter: page.nextAfter === null ? null : encodeCursor(page.nextAfter),
    // Where each result matched, so a person can see why it came back rather
    // than guessing which of title, body or an old key was the reason. Spread
    // rather than set to undefined: the response is canonical JSON, which has
    // no way to represent an absent value and refuses one.
    ...(query === null || query.trim() === ""
      ? {}
      : {
          matches: Object.fromEntries(
            issues.map((issue) => [issue.key, matchedFields(context.board, issue.uid, query)]),
          ),
        }),
    // The selection total a backlog screen shows (§8) — of this page, which is
    // what the screen actually holds.
    points: issues.reduce((total, issue) => total + (issue.points ?? 0), 0),
  });
}

/**
 * The project a request reaches into, when the URL names one.
 *
 * Returns the offending project, or null when the request is within scope.
 * Keys carry their project as a prefix (`LJ-12`, `LJ-S1`), which is what makes
 * this answerable from the URL alone — before the handler, and without a
 * lookup that a quarantined or missing row could refuse.
 *
 * A collection request (`GET /issues`) names no project; the list route narrows
 * itself to the token's project instead of being refused, because an agent
 * asking "what is there" should get its own project rather than an error
 * (S3-D9).
 */
function projectTrespass(
  request: http.IncomingMessage,
  url: URL,
  context: RequestContext,
): string | null {
  const bound = context.token?.projectScope;
  if (!bound) {
    return null;
  }

  const named =
    /^\/projects\/([^/]+)(?:\/|$)/.exec(url.pathname)?.[1] ??
    keyPrefix(/^\/issues\/([^/]+)/.exec(url.pathname)?.[1]) ??
    keyPrefix(/^\/sprints\/([^/]+)/.exec(url.pathname)?.[1]);

  if (named === null || named === undefined) {
    return null;
  }
  const project = decodeURIComponent(named);
  void request;
  return project === bound ? null : project;
}

/** `LJ-12` and `LJ-S1` both belong to `LJ`. */
function keyPrefix(key: string | undefined): string | null {
  if (key === undefined) {
    return null;
  }
  const found = /^([^-]+)-/.exec(decodeURIComponent(key));
  return found ? found[1] : null;
}

/**
 * A key is 1–255 printable ASCII (S3-D4).
 *
 * Bounded because it becomes a primary key, and restricted to printable ASCII
 * because a header carrying control bytes is a client bug worth naming rather
 * than storing.
 */
const IDEMPOTENCY_KEY = /^[\x20-\x7e]{1,255}$/;

/**
 * Makes a create request safe to retry (PRD §5.4).
 *
 * Wraps the handler rather than living inside it, so every create gets the
 * same treatment and a new one cannot forget. The response is captured off the
 * wire, which means what a retry replays is exactly what the first caller saw
 * — including the ETag — rather than a second rendering of the same resource.
 */
async function withIdempotency(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
  run: (idempotency?: { actorId: string; key: string }) => Promise<void>,
): Promise<void> {
  const key = headerValue(request, "idempotency-key");
  if (key === null) {
    // Optional, and without one there is no retry protection. That is the
    // caller's choice to make (r15 AC2).
    return run();
  }
  if (!IDEMPOTENCY_KEY.test(key)) {
    return respondError(
      response, 400, "E_INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be 1–255 printable ASCII characters.",
    );
  }

  const actorId = context.user!.id;
  const requestHash = createHash("sha256")
    // Canonical JSON, so the same request spelled with different key order or
    // whitespace is recognised as the same request.
    .update(canonicalJson((await readJson(request)) as never))
    .digest("hex");

  const claim = context.writable.outbox.reserveIdempotency(actorId, key, requestHash);

  if (claim.outcome === "mismatch") {
    // S3-D4: replaying the first response here would drop this request on the
    // floor while telling the caller it succeeded.
    return respondError(
      response, 409, "E_IDEMPOTENCY_KEY_REUSED",
      "That Idempotency-Key was used for a different request.",
      `First request fingerprint: ${claim.held.requestHash.slice(0, 16)}`,
    );
  }
  if (claim.outcome === "in_progress") {
    return respondError(
      response, 409, "E_IDEMPOTENCY_IN_PROGRESS",
      "That Idempotency-Key is still being processed.",
      "Retry once the first request has answered.",
    );
  }
  if (claim.outcome === "replay") {
    return replayIdempotent(response, claim.held, context);
  }

  const captured = captureResponse(response);
  try {
    await run({ actorId, key });
  } catch (error) {
    context.writable.outbox.releaseIdempotency(actorId, key);
    throw error;
  }

  const result = captured();
  if (result === null || result.status >= 400) {
    // A refused request has not produced anything to replay, and holding the
    // key would stop the caller from retrying with a corrected body.
    context.writable.outbox.releaseIdempotency(actorId, key);
    return;
  }
  context.writable.outbox.completeIdempotency(actorId, key, result);
}

/**
 * Answers a repeat of a request that already succeeded.
 *
 * Two ways in. Normally the stored response is replayed verbatim. After a
 * crash between the write and the response there is no stored body, only the
 * path the write journal recorded — and re-reading that resource is what keeps
 * the retry from creating a second one (AC10).
 */
function replayIdempotent(
  response: http.ServerResponse,
  held: IdempotencyRecord,
  context: RequestContext,
): void {
  if (held.body !== null && held.status !== null) {
    response.writeHead(held.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(held.body),
      ...(held.etag ? { ETag: held.etag } : {}),
    });
    return void response.end(held.body);
  }

  const key = held.targetPath === null ? null : issueKeyOf(held.targetPath);
  const found = key === null ? null : findIssue(context.board, key);
  if (!found || !("issue" in found)) {
    return respondError(
      response, 409, "E_IDEMPOTENCY_IN_PROGRESS",
      "That Idempotency-Key belongs to a request whose result cannot be read back.",
    );
  }
  respondResource(response, 201, found.issue.resource as JsonValue, found.issue.etag);
}

function issueKeyOf(targetPath: string): string | null {
  return /^issues\/[^/]+\/([^/]+)\.md$/.exec(targetPath)?.[1] ?? null;
}

/**
 * Records the status, body and ETag a handler writes.
 *
 * By wrapping the socket rather than asking each route to report what it sent,
 * so a route that answers through some other helper is captured too.
 */
function captureResponse(
  response: http.ServerResponse,
): () => { status: number; body: string; etag: string | null } | null {
  const writeHead = response.writeHead.bind(response);
  const end = response.end.bind(response);
  let status = 0;
  let etag: string | null = null;
  const chunks: Buffer[] = [];

  response.writeHead = ((code: number, headers?: Record<string, unknown>) => {
    status = code;
    const found = headers?.ETag ?? headers?.etag;
    etag = typeof found === "string" ? found : null;
    return writeHead(code, headers as never);
  }) as typeof response.writeHead;

  response.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk, "utf8"));
    } else if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    }
    return end(chunk as never, ...(rest as []));
  }) as typeof response.end;

  return () =>
    status === 0 ? null : { status, body: Buffer.concat(chunks).toString("utf8"), etag };
}

async function createIssueRoute(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
  idempotency?: { actorId: string; key: string },
): Promise<void> {
  const body = await readJson(request);

  try {
    const issue = await createIssue(
      context.writable,
      {
        project: String(body.project ?? ""),
        type: String(body.type ?? ""),
        title: String(body.title ?? ""),
        description: typeof body.description === "string" ? body.description : undefined,
        points: body.points === undefined || body.points === null ? null : Number(body.points),
        assignee: typeof body.assignee === "string" ? body.assignee : null,
        parent: typeof body.parent === "string" ? body.parent : null,
        labels: Array.isArray(body.labels) ? body.labels.map(String) : [],
        acceptance: Array.isArray(body.acceptance)
          ? body.acceptance.map((item) =>
              typeof item === "string" ? { text: item } : { text: String((item as Record<string, unknown>).text ?? "") },
            )
          : [],
        status: typeof body.status === "string" ? body.status : undefined,
        idempotency,
      },
      actorOf(context),
    );

    response.setHeader("Location", `/issues/${issue.key}`);
    publishIssueChange(context, issue.key, issue.uid, "created");
    respondResource(response, 201, issue.resource as JsonValue, issue.etag);
  } catch (error) {
    if (error instanceof IssueError) {
      return respondError(response, 400, error.code, error.message, error.detail);
    }
    throw error;
  }
}

async function updateIssueRoute(
  key: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const body = await readJson(request);

  const immutable = IMMUTABLE_FIELDS.filter((field) => body[field] !== undefined);
  if (immutable.length > 0) {
    // These are server-owned. Accepting them would let a client rewrite the
    // identity of an issue that other files already reference by uid.
    return respondError(
      response, 400, "E_IMMUTABLE_FIELD",
      `These fields cannot be changed: ${immutable.join(", ")}`,
    );
  }

  try {
    const result = await updateIssue(
      context.writable,
      key,
      headerValue(request, "if-match"),
      {
        title: typeof body.title === "string" ? body.title : undefined,
        points: body.points === undefined ? undefined : body.points === null ? null : Number(body.points),
        labels: Array.isArray(body.labels) ? body.labels.map(String) : undefined,
        assignee: body.assignee === undefined ? undefined : (body.assignee as string | null),
        parent: body.parent === undefined ? undefined : (body.parent as string | null),
        sprint: body.sprint === undefined ? undefined : (body.sprint as string | null),
        acceptance: Array.isArray(body.acceptance)
          ? body.acceptance.map((item) =>
              typeof item === "string"
                ? { text: item }
                : {
                    text: String((item as Record<string, unknown>)?.text ?? ""),
                    done: (item as Record<string, unknown>)?.done === true,
                  },
            )
          : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        status: typeof body.status === "string" ? body.status : undefined,
      },
      actorOf(context),
    );

    if (result.changed) {
      publishIssueChange(context, result.issue.key, result.issue.uid, "updated");
    }
    respondResource(response, 200, result.issue.resource as JsonValue, result.issue.etag);
  } catch (error) {
    return handleWriteError(error, response);
  }
}

// ── runs and claims ─────────────────────────────────────────────────────────

async function startRunRoute(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
  idempotency?: { actorId: string; key: string },
): Promise<void> {
  const body = await readJson(request);
  try {
    const run = await startRun(
      context.writable,
      {
        issue: String(body.issue ?? ""),
        sessionId: String(body.session_id ?? ""),
        agentId: String(body.agent_id ?? ""),
        initiatedBy: String(body.initiated_by ?? ""),
        branch: String(body.branch ?? ""),
        idempotency,
      },
      actorOf(context),
    );
    response.setHeader("Location", `/runs/${run.runId}`);
    respondJson(response, 201, runView(run));
  } catch (error) {
    return respondRunError(error, response);
  }
}

async function heartbeatRoute(
  runId: string,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  try {
    const run = await heartbeatRun(context.writable, runId, actorOf(context), (updated) => {
      // S3-D3: one signal moves both. The claim's lease is renewed here rather
      // than by its own endpoint, so a live run can never hold a dead claim.
      context.runtime.renew(updated.runId);
    });
    respondJson(response, 200, {
      ...runView(run),
      claim: claimView(context.runtime.findByRun(run.runId)),
    });
  } catch (error) {
    return respondRunError(error, response);
  }
}

async function endRunRoute(
  runId: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const body = await readJson(request);
  const state = String(body.state ?? "DONE");
  if (state !== "DONE" && state !== "FAILED" && state !== "CANCELLED") {
    return respondError(
      response, 400, "E_INVALID_RUN_STATE",
      `A run ends as DONE, FAILED or CANCELLED, not ${state}.`,
    );
  }

  try {
    const run = await endRun(
      context.writable,
      runId,
      { state, result: (body.result ?? null) as JsonValue | null },
      actorOf(context),
    );
    // The claim goes with the run: an ended session holding an issue is the
    // ghost occupancy ADR-004 exists to prevent.
    context.runtime.releaseRun(runId);
    respondJson(response, 200, runView(run));
  } catch (error) {
    return respondRunError(error, response);
  }
}

function listRunsRoute(
  url: URL,
  response: http.ServerResponse,
  context: RequestContext,
): void {
  const issue = url.searchParams.get("issue");
  if (issue === null) {
    return respondError(
      response, 400, "E_FILTER_REQUIRED",
      "Say which issue's runs to list: /runs?issue=LJ-12",
    );
  }
  const found = findIssue(context.board, issue);
  if (!found || !("issue" in found)) {
    return respondError(response, 404, "E_UNKNOWN_ISSUE", `No issue ${issue}.`);
  }
  respondJson(response, 200, {
    runs: listRunsFor(context.board, found.issue.uid).map(runView),
  });
}

async function claimRoute(
  key: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const body = await readJson(request);
  try {
    const result = await claimIssue(
      context.writable,
      context.runtime,
      key,
      String(body.run_id ?? ""),
      actorOf(context),
    );
    // 200 either way: a repeat from the same run is the same claim with a new
    // lease, and 201 would say something was created that was not (D10).
    respondJson(response, 200, { ...claimView(result.claim), issue: result.issueKey });
  } catch (error) {
    if (error instanceof ClaimError) {
      const status = error.code === "E_UNKNOWN_ISSUE" || error.code === "E_UNKNOWN_RUN" ? 404 : 409;
      return respondError(response, status, error.code, error.message, error.detail, error.extra);
    }
    return respondRunError(error, response);
  }
}

function runView(run: RunRecord): Record<string, unknown> {
  return {
    run_id: run.runId,
    issue: run.issueKey,
    session_id: run.sessionId,
    agent_id: run.agentId,
    initiated_by: run.initiatedBy,
    branch: run.branch,
    state: run.state,
    // Reported beside `state` rather than folded into it: a stale run is still
    // RUNNING and still holds its claim, and collapsing the two would make the
    // warning look like a conclusion (ADR-004 §3, S3-D2).
    stale: run.stale,
    started_at: run.startedAt,
    last_heartbeat_at: run.lastHeartbeatAt,
    ended_at: run.endedAt,
    result: run.result,
  };
}

/**
 * The most recent run on an issue, reduced to what a card shows.
 *
 * Only the latest, because a card has room for one badge and the question it
 * answers is "what is happening now". The full list is on the issue detail.
 */
function latestRunBadge(
  context: RequestContext,
  issueUid: string,
): Record<string, unknown> | null {
  const [latest] = listRunsFor(context.board, issueUid);
  return latest === undefined
    ? null
    : {
        run_id: latest.runId,
        agent_id: latest.agentId,
        initiated_by: latest.initiatedBy,
        state: latest.state,
        stale: latest.stale,
        // A run that ended without a result is not the same as one that
        // finished, and S5 asks for the difference to be visible (r17b AC10).
        has_result: latest.result !== null,
      };
}

function claimView(claim: Claim | null): Record<string, unknown> | null {
  return claim === null
    ? null
    : {
        owner_id: claim.ownerId,
        run_id: claim.runId,
        acquired_at: new Date(claim.acquiredAt).toISOString(),
        last_heartbeat_at: new Date(claim.lastHeartbeatAt).toISOString(),
        lease_expires_at: new Date(claim.leaseExpiresAt).toISOString(),
      };
}

function respondRunError(error: unknown, response: http.ServerResponse): void {
  if (error instanceof RunError) {
    const status =
      error.code === "E_UNKNOWN_RUN" || error.code === "E_UNKNOWN_ISSUE"
        ? 404
        : error.code === "E_RUN_NOT_OWNED"
          ? 403
          : error.code === "E_RUN_NOT_RUNNING"
            ? 409
            : 400;
    return respondError(response, status, error.code, error.message, error.detail);
  }
  if (error instanceof IssueError) {
    return respondError(response, 400, error.code, error.message, error.detail);
  }
  throw error;
}

/** The three an agent may not reach on scope alone (§6.1, ADR-004 §2). */
const CLAIM_GATED = new Set(["IN_PROGRESS", "IN_REVIEW", "DONE"]);

/**
 * Whether this actor holds a live claim on the issue.
 *
 * The one gate the transition route consults, and the only place that decides
 * what "holding a claim" means. An agent reaching IN_PROGRESS with somebody
 * else's claim, or with none, is refused by this returning false.
 */
function holdsClaim(context: RequestContext, key: string): boolean {
  const found = findIssue(context.board, key);
  if (!found || !("issue" in found)) {
    return false;
  }
  return holdsClaimOn(context.runtime, found.issue.uid, context.user!.id);
}

async function transitionRoute(
  key: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const body = await readJson(request);

  const to = String(body.to ?? "");
  if (actorOf(context).kind === "agent" && CLAIM_GATED.has(to) && !holdsClaim(context, key)) {
    await recordDenial(context, {
      capability: "issue:write",
      scope: "issue:transition",
      role: context.user!.role,
    });
    // §6.1: holding `issue:transition` is not enough. Two agents that both had
    // the scope would otherwise both start the same issue, which is the exact
    // duplicate-work claims exist to prevent (AC19).
    return respondError(
      response, 403, "E_CLAIM_REQUIRED",
      `Moving an issue to ${to} needs a claim held by this agent.`,
      "Claim the issue first: POST /issues/{key}/claim",
    );
  }

  try {
    const result = await transitionIssue(
      context.writable,
      key,
      headerValue(request, "if-match"),
      { to: String(body.to ?? ""), reason: typeof body.reason === "string" ? body.reason : undefined },
      actorOf(context),
      context.user!.role,
    );
    if (result.changed) {
      publishIssueChange(context, result.issue.key, result.issue.uid, "transitioned");
    }
    respondResource(response, 200, result.issue.resource as JsonValue, result.issue.etag);
  } catch (error) {
    if (error instanceof TransitionError) {
      // 403 when the move exists but this role may not make it; 400 when the
      // move does not exist at all. Conflating them would tell an ordinary
      // member to try a transition that will never be allowed.
      const status = error.code === "E_TRANSITION_FORBIDDEN" ? 403 : 400;
      return respondJson(response, status, {
        error: { code: error.code, message: error.message, detail: null },
        allowed: error.allowed,
      });
    }
    return handleWriteError(error, response);
  }
}

async function deleteRoute(
  key: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  try {
    const found = findIssue(context.board, key);
    const uid = found && "issue" in found ? found.issue.uid : null;
    const requested = new URL(request.url ?? "/", "http://localhost").searchParams.get("strategy");
    if (requested !== null && requested !== "promote" && requested !== "cascade_cancel") {
      return respondError(
        response, 400, "E_INVALID_STRATEGY",
        `"${requested}" is not a deletion strategy.`,
        "Use strategy=promote or strategy=cascade_cancel.",
      );
    }
    await deleteIssue(
      context.writable,
      key,
      headerValue(request, "if-match"),
      actorOf(context),
      requested as DeleteStrategy | null,
    );
    publishIssueChange(context, key, uid, "deleted");
    response.writeHead(204).end();
  } catch (error) {
    return handleWriteError(error, response);
  }
}

function publishIssueChange(
  context: RequestContext,
  key: string,
  uid: string | null,
  action: "created" | "updated" | "transitioned" | "deleted",
): void {
  context.stream.publish({
    type: "issue.changed",
    data: { key, uid, source: "api", action },
  });
}

/**
 * Checks a capability before running the route.
 *
 * Authorisation sits in front of the handler rather than inside it so that a
 * new route cannot quietly ship without a check — forgetting `guard` is
 * visible at the routing table, while forgetting a call buried in a handler
 * is not.
 */
async function guard(
  response: http.ServerResponse,
  context: RequestContext,
  capability: Capability,
  scope: TokenScope | null,
  body: () => Promise<void> | void,
): Promise<void> {
  // Two axes, checked in order. A role says what a person may do; a token's
  // scopes say what that person's token may do on their behalf, and a token can
  // never exceed the account it belongs to. `null` means no scope in §6.4's
  // fixed seven covers this route, so no token reaches it at all — restructuring
  // sprints and rebuilding the index are operating the board, not using it.
  if (context.token) {
    // The token's scopes are the authority here, not the role's capabilities.
    // The `agent` role deliberately grants nothing but reading (D9) precisely
    // so that a token's scopes decide — checking both would mean the role
    // silently overrules the scope it was written to defer to. No scope in the
    // seven exceeds what a `member` may do, so this cannot widen an account.
    if (scope === null || !context.token.scopes.includes(scope)) {
      await recordDenial(context, {
        capability,
        scope,
        role: context.user!.role,
      });
      return respondError(
        response,
        403,
        "E_TOKEN_SCOPE",
        scope === null
          ? `No token scope permits ${capability.replace(":", " ")}.`
          : `This token does not hold ${scope}.`,
        scope === null ? "Use a signed-in session." : `Required scope: ${scope}`,
      );
    }
    return body();
  }

  try {
    requireCapability(context.user!.role, capability);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      // A refused attempt on an operational capability is itself auditable —
      // "who tried to manage accounts" is exactly what N7 wants recorded.
      if (capability === "user:manage" || capability === "token:manage") {
        await recordEvent(context, {
          verb: "access.denied",
          targetKind: "board",
          targetUid: null,
          actor: { id: context.user!.id, kind: "human" },
          detail: { capability, role: context.user!.role },
        });
      }
      // 403, not 401: the caller is known, and repeating the request with the
      // same identity will never succeed.
      return respondError(response, 403, error.code, error.message, `Required: ${capability}`);
    }
    throw error;
  }
  await body();
}

/**
 * Issues a PAT.
 *
 * The plaintext appears in this response and nowhere else, ever — there is no
 * route that can produce it again because nothing stores it (r13a AC2).
 */
async function createTokenRoute(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  return guard(response, context, "token:manage", null, async () => {
    const body = await readJson(request);
    const subject = typeof body.user === "string" ? body.user : context.user!.id;

    // S3-D8: a member issues for themselves; issuing under someone else's name
    // is an admin act, because the token's actions will be audited as theirs.
    if (!canManageTokensFor(context.user!, subject)) {
      await recordEvent(context, {
        verb: "access.denied",
        targetKind: "board",
        targetUid: null,
        actor: { id: context.user!.id, kind: "human" },
        detail: { capability: "token:manage", role: context.user!.role, subject },
      });
      return respondError(
        response, 403, "E_FORBIDDEN",
        "Only an admin may issue a token for another account.",
        "Omit `user` to issue one for yourself.",
      );
    }

    if (!listUsers(context.board).some((entry) => entry.id === subject)) {
      return respondError(response, 400, "E_UNKNOWN_USER", `No user ${subject}.`);
    }

    const requested = Array.isArray(body.scopes)
      ? body.scopes.map(String)
      : [...DEFAULT_AGENT_SCOPES];
    const invalid = requested.filter((scope) => !isTokenScope(scope));
    if (invalid.length > 0) {
      return respondError(
        response, 400, "E_INVALID_SCOPE",
        `Not a scope: ${invalid.join(", ")}.`,
        `Allowed: ${TOKEN_SCOPES.join(", ")}`,
      );
    }

    let expiresAt: number | null;
    try {
      expiresAt = resolveExpiry(body.expires_in_days);
    } catch (error) {
      return respondError(response, 400, "E_INVALID_EXPIRY", (error as Error).message);
    }

    const issued = context.store.createToken({
      userId: subject,
      name: typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : null,
      scopes: requested,
      projectScope: typeof body.project_scope === "string" ? body.project_scope : null,
      expiresAt,
    });

    await recordEvent(context, {
      verb: "token.issued",
      targetKind: "user",
      targetUid: subject,
      actor: { id: context.user!.id, kind: "human" },
      // `redact` still runs over this. It keeps `token_id` by name and would
      // drop the plaintext if a later edit ever put it here (r13a AC9).
      after: redact({
        token_id: issued.record.tokenId,
        user: subject,
        scopes: issued.record.scopes,
        project_scope: issued.record.projectScope,
        expires_at: issued.record.expiresAt,
      }),
    });

    respondJson(response, 201, {
      token: issued.token,
      ...tokenView(issued.record),
    });
  });
}

function listTokensRoute(response: http.ServerResponse, context: RequestContext): void {
  // An admin sees every token because revoking a stranger's is their job; a
  // member sees their own, which is all they may act on anyway (S3-D8).
  const records =
    context.user!.role === "admin"
      ? context.store.listTokens()
      : context.store.listTokens(context.user!.id);
  respondJson(response, 200, { tokens: records.map(tokenView) });
}

async function revokeTokenRoute(
  tokenId: string,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  return guard(response, context, "token:manage", null, async () => {
    const record = context.store.findToken(tokenId);
    if (!record) {
      return respondError(response, 404, "E_UNKNOWN_TOKEN", `No token ${tokenId}.`);
    }
    if (!canManageTokensFor(context.user!, record.userId)) {
      return respondError(
        response, 403, "E_FORBIDDEN",
        "Only an admin may revoke another account's token.",
      );
    }

    if (!context.store.revokeToken(tokenId)) {
      // Already revoked. Saying so beats a second event claiming it happened
      // twice, and the caller's goal — the token is dead — already holds.
      return respondJson(response, 200, tokenView(context.store.findToken(tokenId)!));
    }

    await recordEvent(context, {
      verb: "token.revoked",
      targetKind: "user",
      targetUid: record.userId,
      actor: { id: context.user!.id, kind: "human" },
      after: redact({ token_id: tokenId, user: record.userId }),
    });

    respondJson(response, 200, tokenView(context.store.findToken(tokenId)!));
  });
}

/** The token as an API response shows it — never the secret. */
function tokenView(record: TokenRecord): Record<string, unknown> {
  return {
    token_id: record.tokenId,
    user: record.userId,
    name: record.name,
    scopes: record.scopes,
    project_scope: record.projectScope,
    created_at: new Date(record.createdAt).toISOString(),
    expires_at: record.expiresAt === null ? null : new Date(record.expiresAt).toISOString(),
    last_used_at: record.lastUsedAt === null ? null : new Date(record.lastUsedAt).toISOString(),
    revoked_at: record.revokedAt === null ? null : new Date(record.revokedAt).toISOString(),
  };
}

/**
 * Turns `expires_in_days` into an instant, or null for a token that never
 * expires (S3-D7). Absent means the default; explicit `null` means unlimited,
 * and the two are told apart so "I did not say" cannot silently become "never".
 */
function resolveExpiry(value: unknown, now: number = Date.now()): number | null {
  if (value === undefined) {
    return now + TOKEN_DEFAULT_TTL_MS;
  }
  if (value === null) {
    return null;
  }
  const days = Number(value);
  if (!Number.isFinite(days) || !Number.isInteger(days) || days <= 0) {
    return (() => {
      throw new Error("`expires_in_days` must be a positive whole number, or null for no expiry.");
    })();
  }
  return now + days * 24 * 60 * 60 * 1000;
}

async function createUserRoute(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  return guard(response, context, "user:manage", null, async () => {
    const body = await readJson(request);
    try {
      const user = createUser(context.board, {
        id: String(body.id ?? ""),
        displayName: String(body.display_name ?? body.displayName ?? ""),
        role: String(body.role ?? "member") as Role,
        password: String(body.password ?? ""),
      });
      // N7 counts account changes as auditable. `redact` runs even though the
      // record here holds nothing secret, so the guarantee does not depend on
      // this call site staying careful.
      await recordEvent(context, {
        verb: "user.created",
        targetKind: "user",
        targetUid: user.id,
        actor: { id: context.user!.id, kind: "human" },
        after: redact({ ...user }),
      });
      respondJson(response, 201, { user });
    } catch (error) {
      return respondUserError(error, response);
    }
  });
}

async function changeRoleRoute(
  userId: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  return guard(response, context, "user:manage", null, async () => {
    const body = await readJson(request);
    try {
      const change = changeRole(context.board, userId, String(body.role ?? "") as Role);
      await recordEvent(context, {
        verb: "user.role_changed",
        targetKind: "user",
        targetUid: userId,
        actor: { id: context.user!.id, kind: "human" },
        before: { role: change.from },
        after: { role: change.to },
      });
      respondJson(response, 200, { user: userId, from: change.from, to: change.to });
    } catch (error) {
      return respondUserError(error, response);
    }
  });
}

function respondUserError(error: unknown, response: http.ServerResponse): void {
  if (error instanceof UserError) {
    const status = error.code === "E_LAST_ADMIN" ? 409 : 400;
    return respondError(response, status, error.code, error.message, error.detail);
  }
  throw error;
}

/** Appends an event that is not attached to a file write. */
async function recordEvent(
  context: RequestContext,
  input: Parameters<typeof buildEvent>[1],
): Promise<void> {
  const event = buildEvent(context.board.localDirectory, input);
  await context.writable.writer.write({
    kind: "event",
    targetPath: event.path,
    contents: null,
    event,
    actorId: input.actor.id,
    actorKind: input.actor.kind,
  });
}

function actorOf(context: RequestContext): {
  id: string;
  kind: "human" | "agent";
  tokenId: string | null;
} {
  return {
    id: context.user!.id,
    kind: context.user!.role === "agent" ? "agent" : "human",
    // Carried on every write an agent makes, so AC16's "성공·거부 양쪽 모두
    // token_id와 함께" holds for the success half without each route
    // remembering to add it.
    tokenId: context.token?.tokenId ?? null,
  };
}

/**
 * Records a refusal.
 *
 * AC16 audits denials as well as successes: knowing a token was stopped, and
 * which one, is how a misbehaving agent is found. Kept out of the read path —
 * N7 excludes reads, and an agent polling a route it cannot use would otherwise
 * become the loudest writer on the board.
 */
async function recordDenial(
  context: RequestContext,
  detail: { capability: Capability; scope: TokenScope | null; role: string; project?: string },
): Promise<void> {
  if (detail.scope === "issue:read") {
    return;
  }
  await recordEvent(context, {
    verb: "access.denied",
    targetKind: "board",
    targetUid: null,
    actor: actorOf(context),
    detail: {
      capability: detail.capability,
      scope: detail.scope,
      role: detail.role,
      ...(detail.project === undefined ? {} : { project: detail.project }),
    },
  });
}

function headerValue(request: http.IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

/** Shared mapping so every write route reports a conflict the same way. */
function handleWriteError(error: unknown, response: http.ServerResponse): void {
  if (error instanceof PreconditionRequiredError) {
    response.setHeader("ETag", formatEtag(error.currentEtag));
    return respondError(
      response, 428, error.code, error.message,
      "Read the issue first and send its ETag as If-Match.",
    );
  }
  if (error instanceof PreconditionFailedError) {
    response.setHeader("ETag", formatEtag(error.currentEtag));
    return respondJson(response, 412, {
      error: { code: error.code, message: error.message, detail: null },
      etag: error.currentEtag,
      document: error.document,
      conflicts: error.conflicts,
    });
  }
  if (error instanceof QuarantinedError) {
    // 409 rather than 423: the entity is not locked by anybody, it is in a
    // state the board cannot vouch for, and the fix is in the file.
    return respondJson(response, 409, {
      error: { code: error.code, message: error.message, detail: error.recovery },
      reason: error.reason,
      path: error.path,
    });
  }
  if (error instanceof SprintConflictError) {
    return respondJson(response, 409, {
      error: { code: error.code, message: error.message, detail: null },
      active: error.active,
      // The files, so a person can go and fix one of them.
      paths: error.paths,
    });
  }
  if (error instanceof SprintStateError) {
    return respondJson(response, 409, {
      error: { code: error.code, message: error.message, detail: null },
      status: error.status,
      active: error.active,
    });
  }
  if (error instanceof SprintNotEmptyError) {
    return respondJson(response, 409, {
      error: { code: error.code, message: error.message, detail: null },
      issues: error.issues,
      strategies: error.strategies,
    });
  }
  if (error instanceof ChildrenPresentError) {
    // The caller has to choose, so the response carries everything the choice
    // needs: which children, and what the options are called.
    return respondJson(response, 409, {
      error: { code: error.code, message: error.message, detail: null },
      children: error.children,
      strategies: error.strategies,
    });
  }
  if (error instanceof IssueError) {
    const status = error.code === "E_UNKNOWN_PROJECT" ? 404
      : error.code === "E_LINK_NOT_FOUND" ? 404
      : error.code === "E_KEY_COLLISION" ? 409
      : error.code === "E_STRATEGY_IMPOSSIBLE" ? 409
      : error.code === "E_SPRINT_NOT_DELETABLE" ? 409
      : 400;
    return respondError(response, status, error.code, error.message, error.detail);
  }
  throw error;
}

/**
 * The children of an issue, as their own resource.
 *
 * Deliberately not folded into the issue body. That body is the file's
 * representation and its hash is the ETag (ADR-003), so including a derived
 * list would make an issue's validator change whenever some *other* issue was
 * reparented onto it — an If-Match conflict caused by an edit the caller never
 * made and cannot see.
 */
function childrenRoute(
  key: string,
  response: http.ServerResponse,
  context: RequestContext,
): void {
  const found = findIssue(context.board, key);
  if (found === null || !("issue" in found)) {
    return respondError(response, 404, "E_ISSUE_NOT_FOUND", `No issue with key ${key}`);
  }
  respondJson(response, 200, { children: childrenOf(context.board, found.issue.uid) });
}

async function rankRoute(
  key: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const body = await readJson(request);
  const field = String(body.field ?? "backlog_rank");

  if (!isRankField(field)) {
    return respondError(
      response, 400, "E_INVALID_RANK_FIELD",
      `"${field}" is not an ordering.`,
      "Use backlog_rank or board_rank.",
    );
  }

  try {
    const result = await moveIssue(
      context.writable,
      key,
      {
        field,
        after: typeof body.after === "string" ? body.after : null,
        before: typeof body.before === "string" ? body.before : null,
      },
      actorOf(context),
      headerValue(request, "if-match"),
    );

    if (result.changed) {
      publishIssueChange(context, key, null, "updated");
    }
    respondJson(response, 200, {
      key,
      field,
      rank: result.rank,
      changed: result.changed,
      // Named, not just counted: a rebalance rewrites other people's files and
      // the caller's view of them is now stale.
      rebalanced: result.rebalanced,
    });
  } catch (error) {
    if (error instanceof NeighboursMovedError) {
      return respondJson(response, 409, {
        error: { code: error.code, message: error.message, detail: null },
        order: error.order,
      });
    }
    if (error instanceof RankSpaceExhausted) {
      return respondError(
        response, 409, error.code, error.message,
        "The region could not be rebalanced. Reload the list and try again.",
      );
    }
    return handleWriteError(error, response);
  }
}

/**
 * The active sprint and what is in it.
 *
 * Scoped to one sprint rather than the whole project: a board is what the team
 * is doing now, and a column holding every issue that ever existed answers a
 * different question. With no active sprint this is an empty board, not an
 * error — a project between sprints is an ordinary state (§8).
 */
function respondBoard(
  project: string,
  response: http.ServerResponse,
  context: RequestContext,
): void {
  const active = listSprints(context.board, project, "ACTIVE");
  const health = boardHealth(context.board.db);
  const conflicted = health.sprintConflicts.includes(project);

  if (active.length === 0 || conflicted) {
    return respondJson(response, 200, {
      sprint: null,
      issues: [],
      columns: [],
      // Told apart on purpose: "no sprint is running" and "the board cannot
      // tell which sprint is running" need different things from a person.
      reason: conflicted ? "sprint_conflict" : "no_active_sprint",
      sprintConflicts: health.sprintConflicts,
    });
  }

  const sprint = active[0];
  const page = listIssues(context.board, { project, sprint: [sprint.id], limit: 500 });
  const kinds = lastActorKinds(context.board, page.issues.map((issue) => issue.uid));

  const issues = page.issues.map(({ createdByKind, ...issue }) => {
    const claim = claimability(context.board, issue.uid);
    const blockedFrom =
      ((context.board.db
        .prepare("SELECT blocked_from FROM issues WHERE uid = ?")
        .get(issue.uid) as { blocked_from: string | null } | undefined)?.blocked_from) ?? null;
    const from = issue.status !== null && isStatus(issue.status) ? issue.status : null;
    return {
      ...issue,
      created_by_kind: createdByKind,
      last_actor_kind: kinds.get(issue.uid) ?? null,
      // Carried on the card so a blocked issue looks blocked, with the reason
      // rather than just a mark (§5.2).
      claimable: claim.claimable,
      blocked_by: claim.blockedBy,
      blocked_from: blockedFrom,
      // Who is on it and how that run is doing. On the card rather than behind
      // a click because S5's whole point is finding the stalled ones by eye.
      claim: claimView(context.runtime.find(issue.uid)),
      run: latestRunBadge(context, issue.uid),
      // Computed here from §5.2 rather than left for the screen to work out.
      // A second copy of the transition table in the client is a copy that
      // drifts, and the first sign would be a drag the board allowed and the
      // server refused.
      allowed_to: from === null
        ? []
        : allowedTargets(from, blockedFrom).filter(
            (to) => !requiresAdmin(from, to) || context.user?.role === "admin",
          ),
    };
  });

  // Every status is a column, in the order work moves through them. BLOCKED
  // gets its own rather than a badge on another column: §5.2 makes it a real
  // status, and a card sitting under a heading it does not have would be a lie
  // the moment anyone dragged it.
  const order = ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "DONE", "CANCELLED"];
  const columns = order.map((status) => {
    const held = issues.filter((issue) => (issue.status ?? "BACKLOG") === status);
    return {
      status,
      count: held.length,
      points: held.reduce((total, issue) => total + (issue.points ?? 0), 0),
      // Shown when it holds something, or when work normally passes through it.
      // A permanently empty CANCELLED column is dead space on every board.
      always: !["BLOCKED", "CANCELLED"].includes(status),
    };
  });

  respondJson(response, 200, {
    sprint: { id: sprint.id, name: sprint.name, goal: sprint.goal, capacity: sprint.capacity },
    plan: planOf(context.board, sprint.id),
    issues,
    columns,
    sprintConflicts: health.sprintConflicts,
  });
}

async function startSprintRoute(
  id: string,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  try {
    const result = await startSprint(context.writable, id, actorOf(context));
    respondJson(response, 200, {
      sprint: result.sprint.resource,
      plan: result.plan,
      // Advisory. Exceeding capacity has never blocked anything (PRD R6, AC5),
      // and the caller gets told so it can say so rather than discover it.
      warning: result.warning,
    });
  } catch (error) {
    return handleWriteError(error, response);
  }
}

async function closeSprintRoute(
  id: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const body = await readJson(request);
  const carry = body.carry_over as { to?: unknown } | undefined;

  try {
    const result = await closeSprint(
      context.writable,
      id,
      carry === undefined
        ? {}
        : { carryOver: { to: typeof carry.to === "string" ? carry.to : null } },
      actorOf(context),
    );

    // Asked without a choice, this is a question rather than a command: the
    // sprint is untouched and the answer says what closing would move.
    respondJson(response, 200, {
      pending: result.pending,
      status: result.sprint.status,
      unfinished: result.unfinished,
      // Kept apart from unfinished so "we finished it" and "we decided not to"
      // do not read as the same outcome (S1-D5).
      cancelled: result.cancelled,
      ...(result.pending
        ? { strategies: ["carry_over.to = <sprint id>", "carry_over.to = null"] }
        : { carriedTo: result.carriedTo ?? null }),
    });
  } catch (error) {
    return handleWriteError(error, response);
  }
}

/**
 * Moves several issues into or out of a sprint in one request.
 *
 * Each issue is still its own write with its own precondition — the batch is a
 * convenience for the caller, not a transaction. A partial failure therefore
 * reports which ones moved and which did not, instead of pretending the whole
 * thing either happened or didn't when the files say otherwise.
 */
async function moveIssuesRoute(
  id: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const body = await readJson(request);
  const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
  const target = id === "backlog" ? null : id;

  if (keys.length === 0) {
    return respondError(response, 400, "E_INVALID_REQUEST", "Name at least one issue key.");
  }

  const moved: string[] = [];
  const failed: Array<{ key: string; code: string; message: string }> = [];

  for (const key of keys) {
    try {
      const found = findIssue(context.board, key);
      if (found === null || !("issue" in found)) {
        failed.push({ key, code: "E_ISSUE_NOT_FOUND", message: `No issue with key ${key}` });
        continue;
      }
      await updateIssue(
        context.writable,
        key,
        found.issue.etag,
        { sprint: target },
        actorOf(context),
      );
      moved.push(key);
    } catch (error) {
      const code = error instanceof IssueError ? error.code : "E_INTERNAL";
      failed.push({ key, code, message: describe(error) });
    }
  }

  for (const key of moved) {
    publishIssueChange(context, key, null, "updated");
  }
  respondJson(response, failed.length === 0 ? 200 : 207, { moved, failed });
}

async function createSprintRoute(
  project: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const body = await readJson(request);
  try {
    const sprint = await createSprint(
      context.writable,
      project,
      {
        name: typeof body.name === "string" ? body.name : undefined,
        goal: typeof body.goal === "string" ? body.goal : null,
        start_at: typeof body.start_at === "string" ? body.start_at : undefined,
        end_at: typeof body.end_at === "string" ? body.end_at : undefined,
        capacity: body.capacity === undefined || body.capacity === null
          ? null
          : Number(body.capacity),
        status: typeof body.status === "string" ? body.status : undefined,
      },
      actorOf(context),
    );
    response.setHeader("Location", `/sprints/${sprint.id}`);
    respondResource(response, 201, sprint.resource as JsonValue, sprint.etag);
  } catch (error) {
    return handleWriteError(error, response);
  }
}

async function updateSprintRoute(
  id: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const body = await readJson(request);
  try {
    const result = await updateSprint(
      context.writable,
      id,
      headerValue(request, "if-match"),
      {
        name: typeof body.name === "string" ? body.name : undefined,
        goal: body.goal === undefined ? undefined : (body.goal as string | null),
        start_at: typeof body.start_at === "string" ? body.start_at : undefined,
        end_at: typeof body.end_at === "string" ? body.end_at : undefined,
        capacity: body.capacity === undefined ? undefined : (body.capacity as number | null),
        status: typeof body.status === "string" ? body.status : undefined,
      },
      actorOf(context),
    );
    respondResource(response, 200, result.sprint.resource as JsonValue, result.sprint.etag);
  } catch (error) {
    return handleWriteError(error, response);
  }
}

async function deleteSprintRoute(
  id: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const requested = new URL(request.url ?? "/", "http://localhost").searchParams.get("strategy");
  if (requested !== null && requested !== "release") {
    return respondError(
      response, 400, "E_INVALID_STRATEGY",
      `"${requested}" is not a strategy for deleting a sprint.`,
      "Use strategy=release to send its issues back to the backlog.",
    );
  }

  try {
    await deleteSprint(
      context.writable,
      id,
      headerValue(request, "if-match"),
      actorOf(context),
      requested as "release" | null,
    );
    response.writeHead(204).end();
  } catch (error) {
    return handleWriteError(error, response);
  }
}

/** What the settings screen shows about the index. */
function indexReport(context: RequestContext): Record<string, unknown> {
  const status = indexStatus(context.board);
  const health = boardHealth(context.board.db);
  return {
    boardPath: status.boardPath,
    schemaVersion: status.schemaVersion,
    lastRebuildAt: status.lastRebuildAt,
    lastVerifyAt: lastVerifyAt,
    counts: status.counts,
    quarantined: status.errors.length,
    sprintConflicts: health.sprintConflicts,
    running: context.indexBusy() ? "rebuild" : verifying ? "verify" : null,
  };
}

// Module-level rather than per-request: two callers pressing the same button
// must see one run, not two (AC), and the report has to say so.
let verifying = false;
let lastVerifyAt: string | null = null;

/**
 * Rebuilds the index from files, swapping generations underneath the readers.
 *
 * Domain writes queue while the swap happens rather than failing, but only for
 * a bounded wait: a caller blocked with no end in sight is worse off than one
 * told to come back (설계 §3.7). Reads never pause — the previous generation
 * keeps serving until the new one is complete.
 */
async function rebuildRoute(
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  if (context.indexBusy()) {
    return respondError(
      response, 409, "E_INDEX_BUSY",
      "A rebuild is already running.",
    );
  }

  const started = Date.now();
  let settle: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    settle = resolve;
  });
  void context.closeWriteGate(gate);

  try {
    const before = indexStatus(context.board).counts;
    context.board.refreshIndex();
    const after = indexStatus(context.board).counts;

    respondJson(response, 200, {
      rebuilt: true,
      durationMs: Date.now() - started,
      counts: after,
      // Reported so a caller can see the rebuild agreed with what was there,
      // which is the whole claim being made (AC2).
      unchanged: JSON.stringify(before) === JSON.stringify(after),
    });
  } catch (error) {
    respondError(response, 500, "E_INDEX_REBUILD_FAILED", describe(error));
  } finally {
    settle();
  }
}

/**
 * Re-hashes every file rather than trusting `(mtime, size)`.
 *
 * The case this exists for: a file whose content changed while its stat fields
 * did not. Startup narrows candidates by metadata and would sail past it, so
 * "verify" means exactly "do not narrow" (설계 §3.7).
 */
async function verifyRoute(
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  if (verifying) {
    return respondError(response, 409, "E_INDEX_BUSY", "A verification is already running.");
  }

  verifying = true;
  const started = Date.now();
  try {
    const before = quarantineList(context.board.db).length;
    // A full reconcile *is* the verification: it hashes everything it scans.
    await context.reconcile("manual");
    const after = quarantineList(context.board.db).length;
    lastVerifyAt = new Date().toISOString();

    respondJson(response, 200, {
      verified: true,
      durationMs: Date.now() - started,
      quarantinedBefore: before,
      quarantinedAfter: after,
      newlyQuarantined: Math.max(0, after - before),
      released: Math.max(0, before - after),
    });
  } catch (error) {
    respondError(response, 500, "E_INDEX_VERIFY_FAILED", describe(error));
  } finally {
    verifying = false;
  }
}

/**
 * The activity on an issue.
 *
 * Its own route rather than part of the issue body, like children and links:
 * the body is the file and its hash is the ETag, and a timeline grows on its
 * own every time anything happens.
 */
function activityRoute(
  key: string,
  url: URL,
  response: http.ServerResponse,
  context: RequestContext,
): void {
  const found = findIssue(context.board, key);
  if (found === null || !("issue" in found)) {
    return respondError(response, 404, "E_ISSUE_NOT_FOUND", `No issue with key ${key}`);
  }

  const limit = url.searchParams.has("limit")
    ? Number(url.searchParams.get("limit"))
    : undefined;
  const { entries, hasMore } = activityOf(context.board, found.issue.uid, {
    limit: Number.isFinite(limit) ? limit : undefined,
    before: url.searchParams.get("before"),
  });

  respondJson(response, 200, {
    key: found.issue.key,
    entries,
    hasMore,
    // The cursor to ask for the next page with, so a caller never has to
    // construct one out of an entry it may not fully understand.
    nextBefore: hasMore && entries.length > 0 ? entries[entries.length - 1].eventId : null,
  });
}

/** The relations on an issue, both declared and reversed, plus claimability. */
function linksRoute(
  key: string,
  response: http.ServerResponse,
  context: RequestContext,
): void {
  const found = findIssue(context.board, key);
  if (found === null || !("issue" in found)) {
    return respondError(response, 404, "E_ISSUE_NOT_FOUND", `No issue with key ${key}`);
  }
  respondJson(response, 200, {
    links: relatedTo(context.board, found.issue.uid),
    ...claimability(context.board, found.issue.uid),
  });
}

/**
 * The cursor is the sort key itself, encoded.
 *
 * Opaque to the caller so it cannot be built by hand and quietly become an
 * offset, which is the thing this exists to avoid.
 */
/**
 * Which fields a query hit, and a snippet from the body when it hit there.
 *
 * Computed per result rather than joined into the list query: the list is a
 * page of at most 500 and this keeps the search out of the ordering path,
 * where it would have to be reasoned about alongside the rank tie-break.
 */
function matchedFields(
  board: BoardHandle,
  uid: string,
  query: string,
): { fields: string[]; snippet: string | null } {
  const terms = query.trim().split(/\s+/).filter((term) => term !== "");
  const row = board.db
    .prepare("SELECT title, body, key_alias, acceptance FROM issues_fts WHERE uid = ?")
    .get(uid) as
    | { title: string; body: string; key_alias: string; acceptance: string }
    | undefined;

  if (!row) {
    return { fields: [], snippet: null };
  }

  const fields: string[] = [];
  const named: Array<[string, string]> = [
    ["title", row.title],
    ["body", row.body],
    ["acceptance", row.acceptance],
    ["key_alias", row.key_alias],
  ];
  for (const [name, value] of named) {
    if (terms.some((term) => value.toLowerCase().includes(term.toLowerCase()))) {
      fields.push(name);
    }
  }

  let snippet: string | null = null;
  const hit = terms.find((term) => row.body.toLowerCase().includes(term.toLowerCase()));
  if (hit) {
    const at = row.body.toLowerCase().indexOf(hit.toLowerCase());
    const from = Math.max(0, at - 40);
    snippet =
      (from > 0 ? "…" : "") +
      row.body.slice(from, at + hit.length + 40).replace(/\s+/g, " ").trim() +
      (at + hit.length + 40 < row.body.length ? "…" : "");
  }

  return { fields, snippet };
}

function encodeCursor(after: { rank: string | null; uid: string }): string {
  return Buffer.from(`${after.rank ?? ""}\u0000${after.uid}`, "utf8").toString("base64url");
}

function parseCursor(value: string | null): { rank: string | null; uid: string } | null {
  if (value === null || value === "") {
    return null;
  }
  const [rank, uid] = Buffer.from(value, "base64url").toString("utf8").split("\u0000");
  return uid ? { rank: rank === "" ? null : rank, uid } : null;
}

async function addLinkRoute(
  key: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const body = await readJson(request);
  try {
    const result = await addLink(
      context.writable,
      key,
      headerValue(request, "if-match"),
      { kind: String(body.kind ?? ""), to: String(body.to ?? "") },
      actorOf(context),
    );
    if (result.changed) {
      publishIssueChange(context, result.issue.key, result.issue.uid, "updated");
    }
    respondResource(
      response,
      result.changed ? 201 : 200,
      result.issue.resource as JsonValue,
      result.issue.etag,
    );
  } catch (error) {
    return handleWriteError(error, response);
  }
}

async function removeLinkRoute(
  key: string,
  id: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  try {
    const result = await removeLink(
      context.writable,
      key,
      headerValue(request, "if-match"),
      id,
      actorOf(context),
    );
    if (result.changed) {
      publishIssueChange(context, result.issue.key, result.issue.uid, "updated");
    }
    respondResource(response, 200, result.issue.resource as JsonValue, result.issue.etag);
  } catch (error) {
    return handleWriteError(error, response);
  }
}

function showIssueRoute(
  key: string,
  response: http.ServerResponse,
  context: RequestContext,
): void {
  const found = findIssue(context.board, key);

  if (found === null) {
    // A tombstone still answers, because "it was here and it is gone" is a
    // different and more useful answer than "never heard of it" — especially
    // after a pull, where the caller's next question is which file went away.
    const tombstone = findTombstone(context.board.db, key);
    if (tombstone) {
      return respondError(
        response,
        404,
        "E_ISSUE_NOT_FOUND",
        `${key} is no longer on the board.`,
        tombstone.pending
          ? `Last seen at ${tombstone.path}; still within the grace period in case it was moved.`
          : `Last seen at ${tombstone.path}.`,
      );
    }
    return respondError(response, 404, "E_ISSUE_NOT_FOUND", `No issue with key ${key}`);
  }
  if ("ambiguous" in found) {
    return respondError(
      response,
      409,
      "E_KEY_AMBIGUOUS",
      `${key} matches more than one issue`,
      found.ambiguous.join(", "),
    );
  }

  // A count, so a detail screen knows whether to ask for the list at all. The
  // list itself is /issues/{key}/children — see there for why it is not inlined.
  const children = childrenOf(context.board, found.issue.uid);
  if (children.length > 0) {
    response.setHeader("X-Child-Count", String(children.length));
  }

  // Derived from other issues' states, so it belongs outside the body for the
  // same reason: an issue's validator must not move because its blocker was
  // closed. /issues/{key}/links carries the reasons in full.
  const claim = claimability(context.board, found.issue.uid);
  response.setHeader("X-Claimable", String(claim.claimable));
  if (claim.blockedBy.length > 0) {
    response.setHeader("X-Blocked-By", claim.blockedBy.join(","));
  }

  // Headers for the same reason as the two above: a claim is runtime state that
  // comes and goes, and putting it in the body would move the issue's ETag
  // every time an agent picked it up or let it go.
  const held = context.runtime.find(found.issue.uid);
  if (held !== null) {
    response.setHeader("X-Claim-Owner", held.ownerId);
    response.setHeader("X-Claim-Run", held.runId);
    response.setHeader("X-Claim-Lease-Expires", new Date(held.leaseExpiresAt).toISOString());
  }

  // ADR-003: the ETag is the hash of the bytes actually sent, so a single
  // resource is served as its canonical representation rather than wrapped in
  // an envelope whose hash would be something else entirely.
  respondResource(response, 200, found.issue.resource as JsonValue, found.issue.etag);
}

/**
 * Who is making this request — a signed-in person, or a token.
 *
 * Both resolve to a user in `users.yaml`, which is what makes removing someone
 * from that file end their access by every route at once. A token that names a
 * user who is no longer there authenticates as nobody.
 */
function resolveActor(
  request: http.IncomingMessage,
  context: RequestContext,
): { user: UserRecord; token: TokenRecord | null } | null {
  const bearer = bearerToken(request);
  if (bearer !== null) {
    const found = context.store.resolveToken(bearer);
    if (!found.ok) {
      return null;
    }
    const user = listUsers(context.board).find((entry) => entry.id === found.record.userId);
    if (!user) {
      return null;
    }
    context.store.touchToken(found.record.tokenId);
    return { user, token: found.record };
  }

  const token = sessionToken(request);
  if (!token) {
    return null;
  }
  const session = context.store.touchSession(token);
  if (!session) {
    return null;
  }
  const user = listUsers(context.board).find((entry) => entry.id === session.userId);
  return user ? { user, token: null } : null;
}

function bearerToken(request: http.IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function sessionToken(request: http.IncomingMessage): string | null {
  const header = request.headers.cookie;
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      return value.join("=");
    }
  }
  return null;
}

function streamSessionKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function cookie(token: string, expiresAt: number): string {
  // HttpOnly keeps the token out of reach of page scripts, and SameSite=Strict
  // means a third-party page cannot make an authenticated request on behalf of
  // whoever is signed in (S1-D10).
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`;
}

/** Where a body already read off the stream is kept, so it can be read twice. */
const BUFFERED = Symbol("buffered-body");

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const already = (request as never as Record<symbol, Buffer | undefined>)[BUFFERED];
  if (already !== undefined) {
    return already;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  // The idempotency wrapper has to hash the request before the handler parses
  // it, and a stream can only be consumed once.
  (request as never as Record<symbol, Buffer>)[BUFFERED] = body;
  return body;
}

async function readJson(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const raw = await readBody(request);
  if (raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function respondResource(
  response: http.ServerResponse,
  status: number,
  resource: JsonValue,
  etag: string,
): void {
  const body = canonicalJson(resource);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ETag: formatEtag(etag),
  });
  response.end(body);
}

function respondJson(
  response: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  // JCS bytes, so the ETag on an issue is the hash of what actually goes out
  // (ADR-003). The envelope uses the same serialiser for consistency.
  const body = canonicalJson(payload as never);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function respondError(
  response: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  detail: string | null = null,
  /**
   * Fields the caller needs to act on, beside the envelope.
   *
   * A claim refusal has to say who holds it and until when, or an agent that
   * is told 409 has no way to decide whether to wait or give up.
   */
  extra: Record<string, unknown> = {},
): void {
  respondJson(response, status, { error: { code, message, detail }, ...extra });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
