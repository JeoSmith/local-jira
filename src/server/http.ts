import http from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { AuthorizationError, require as requireCapability, type Capability } from "../auth/authorize.ts";
import { CredentialStore } from "../auth/credentials.ts";
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
import { STATUSES } from "../domain/transition.ts";
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
  stream: EventStream;
  user: UserRecord | null;
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
      writable, board, store, stream, user: null,
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
  const user = resolveUser(request, context);
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
  const authed: RequestContext = { ...context, user };

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
  if (route === "GET /issues") {
    return listIssuesRoute(url, response, authed);
  }
  if (route === "POST /issues") {
    return guard(response, authed, "issue:write", () =>
      createIssueRoute(request, response, authed),
    );
  }
  if (request.method === "POST" && url.pathname.endsWith("/transitions")) {
    const key = decodeURIComponent(
      url.pathname.slice("/issues/".length, -"/transitions".length),
    );
    return guard(response, authed, "issue:write", () =>
      transitionRoute(key, request, response, authed),
    );
  }
  if (request.method === "POST" && url.pathname.endsWith("/rank")) {
    const key = decodeURIComponent(url.pathname.slice("/issues/".length, -"/rank".length));
    // Its own capability, not `issue:write`: an agent may edit an issue without
    // being allowed to decide what the team works on next (D9).
    return guard(response, authed, "issue:rank", () =>
      rankRoute(key, request, response, authed),
    );
  }
  if (request.method === "POST" && url.pathname.endsWith("/links")) {
    const key = decodeURIComponent(url.pathname.slice("/issues/".length, -"/links".length));
    return guard(response, authed, "issue:write", () =>
      addLinkRoute(key, request, response, authed),
    );
  }
  if (request.method === "DELETE" && url.pathname.includes("/links/")) {
    const [key, id] = url.pathname
      .slice("/issues/".length)
      .split("/links/")
      .map((part) => decodeURIComponent(part));
    return guard(response, authed, "issue:write", () =>
      removeLinkRoute(key, id, request, response, authed),
    );
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/issues/")) {
    return guard(response, authed, "issue:delete", () =>
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
    return guard(response, authed, "issue:write", () =>
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
    return guard(response, authed, "issue:read", () => {
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
    return guard(response, authed, "issue:read", () => {
      const status = url.searchParams.get("status");
      respondJson(response, 200, {
        sprints: listSprints(authed.board, decodeURIComponent(sprintCollection[1]), status ?? undefined),
      });
    });
  }
  if (sprintCollection && request.method === "POST") {
    return guard(response, authed, "sprint:write", () =>
      createSprintRoute(decodeURIComponent(sprintCollection[1]), request, response, authed),
    );
  }

  const boardRoute = /^\/projects\/([^/]+)\/board$/.exec(url.pathname);
  if (boardRoute && request.method === "GET") {
    return guard(response, authed, "issue:read", () =>
      respondBoard(decodeURIComponent(boardRoute[1]), response, authed),
    );
  }

  const sprintCommand = /^\/sprints\/([^/]+)\/(start|close)$/.exec(url.pathname);
  if (sprintCommand && request.method === "POST") {
    const id = decodeURIComponent(sprintCommand[1]);
    return guard(response, authed, "sprint:write", () =>
      sprintCommand[2] === "start"
        ? startSprintRoute(id, response, authed)
        : closeSprintRoute(id, request, response, authed),
    );
  }

  const sprintPlan = /^\/sprints\/([^/]+)\/plan$/.exec(url.pathname);
  if (sprintPlan && request.method === "GET") {
    return guard(response, authed, "issue:read", () => {
      const plan = planOf(authed.board, decodeURIComponent(sprintPlan[1]));
      if (plan === null) {
        return respondError(response, 404, "E_SPRINT_NOT_FOUND", "No such sprint.");
      }
      respondJson(response, 200, plan);
    });
  }

  const sprintIssues = /^\/sprints\/([^/]+)\/issues$/.exec(url.pathname);
  if (sprintIssues && request.method === "POST") {
    return guard(response, authed, "issue:write", () =>
      moveIssuesRoute(decodeURIComponent(sprintIssues[1]), request, response, authed),
    );
  }

  const sprintItem = /^\/sprints\/([^/]+)$/.exec(url.pathname);
  if (sprintItem) {
    const id = decodeURIComponent(sprintItem[1]);
    if (request.method === "GET") {
      return guard(response, authed, "issue:read", () => {
        const sprint = findSprint(authed.board, id);
        if (sprint === null) {
          return respondError(response, 404, "E_SPRINT_NOT_FOUND", `No sprint with id ${id}`);
        }
        respondResource(response, 200, sprint.resource as JsonValue, sprint.etag);
      });
    }
    if (request.method === "PATCH") {
      return guard(response, authed, "sprint:write", () =>
        updateSprintRoute(id, request, response, authed),
      );
    }
    if (request.method === "DELETE") {
      return guard(response, authed, "sprint:write", () =>
        deleteSprintRoute(id, request, response, authed),
      );
    }
  }

  if (route === "GET /index") {
    return guard(response, authed, "issue:read", () => {
      respondJson(response, 200, indexReport(authed));
    });
  }
  if (route === "POST /index/rebuild") {
    return guard(response, authed, "index:rebuild", () => rebuildRoute(response, authed));
  }
  if (route === "POST /index/verify") {
    return guard(response, authed, "index:verify", () => verifyRoute(response, authed));
  }
  if (route === "GET /integrity/issues") {
    return guard(response, authed, "issue:read", () => {
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
  const page = listIssues(context.board, {
    project: url.searchParams.get("project") ?? undefined,
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
  const issues = page.issues;

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

async function createIssueRoute(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
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
      },
      { id: context.user!.id, kind: context.user!.role === "agent" ? "agent" : "human" },
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
      { id: context.user!.id, kind: context.user!.role === "agent" ? "agent" : "human" },
    );

    if (result.changed) {
      publishIssueChange(context, result.issue.key, result.issue.uid, "updated");
    }
    respondResource(response, 200, result.issue.resource as JsonValue, result.issue.etag);
  } catch (error) {
    return handleWriteError(error, response);
  }
}

async function transitionRoute(
  key: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  const body = await readJson(request);

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
  body: () => Promise<void> | void,
): Promise<void> {
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

async function createUserRoute(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RequestContext,
): Promise<void> {
  return guard(response, context, "user:manage", async () => {
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
  return guard(response, context, "user:manage", async () => {
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

function actorOf(context: RequestContext): { id: string; kind: "human" | "agent" } {
  return {
    id: context.user!.id,
    kind: context.user!.role === "agent" ? "agent" : "human",
  };
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
    return {
      ...issue,
      created_by_kind: createdByKind,
      last_actor_kind: kinds.get(issue.uid) ?? null,
      // Carried on the card so a blocked issue looks blocked, with the reason
      // rather than just a mark (§5.2).
      claimable: claim.claimable,
      blocked_by: claim.blockedBy,
      blocked_from:
        ((context.board.db
          .prepare("SELECT blocked_from FROM issues WHERE uid = ?")
          .get(issue.uid) as { blocked_from: string | null } | undefined)?.blocked_from) ?? null,
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

  // ADR-003: the ETag is the hash of the bytes actually sent, so a single
  // resource is served as its canonical representation rather than wrapped in
  // an envelope whose hash would be something else entirely.
  respondResource(response, 200, found.issue.resource as JsonValue, found.issue.etag);
}

function resolveUser(
  request: http.IncomingMessage,
  context: RequestContext,
): UserRecord | null {
  const token = sessionToken(request);
  if (!token) {
    return null;
  }
  const session = context.store.touchSession(token);
  if (!session) {
    return null;
  }
  return listUsers(context.board).find((user) => user.id === session.userId) ?? null;
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

async function readJson(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
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
): void {
  respondJson(response, status, { error: { code, message, detail } });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
