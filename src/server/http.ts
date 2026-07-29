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
  isRankField,
  moveIssue,
  NeighboursMovedError,
  orderedRegion,
} from "../domain/ordering.ts";
import { RankSpaceExhausted } from "../domain/rank.ts";
import { canonicalJson, type JsonValue } from "../storage/jcs.ts";
import {
  findIssue,
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
    handle(request, response, { writable, board, store, stream, user: null }).catch((error) => {
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

  const cursor = url.searchParams.get("after");
  const page = listIssues(context.board, {
    project: url.searchParams.get("project") ?? undefined,
    status,
    type,
    assignee: many("assignee"),
    label: many("label"),
    sprint,
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
