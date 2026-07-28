import http from "node:http";
import type { AddressInfo } from "node:net";

import { AuthorizationError, require as requireCapability, type Capability } from "../auth/authorize.ts";
import { CredentialStore } from "../auth/credentials.ts";
import { createIssue, IssueError } from "../domain/issue.ts";
import {
  deleteIssue,
  IMMUTABLE_FIELDS,
  PreconditionFailedError,
  PreconditionRequiredError,
  transitionIssue,
  TransitionError,
  updateIssue,
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
import { canonicalJson, type JsonValue } from "../storage/jcs.ts";
import {
  findIssue,
  listIssues,
  openBoardForWriting,
  type BoardHandle,
  type WritableBoard,
} from "../storage/board.ts";
import { reconcileExternal } from "../storage/external.ts";
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
  const reconcile = (): Promise<void> => {
    reconciling = reconciling.then(async () => {
      const result = await reconcileExternal(writable);
      for (const change of result.changed) {
        stream.publish({
          type: "issue.changed",
          data: { key: change.key, uid: change.uid, path: change.path, source: "external" },
        });
      }
      if (result.removed > 0) {
        stream.publish({ type: "index.state", data: { removed: result.removed } });
      }
    }, () => undefined);
    return reconciling;
  };

  let watcher: BoardWatcher | null = null;
  if (options.watch !== false) {
    watcher = watchBoard(board.boardRoot, {
      debounceMs: options.debounceMs,
      onBatch: () => void reconcile(),
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
    return context.stream.attach(request, response);
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
    return showIssueRoute(decodeURIComponent(url.pathname.slice("/issues/".length)), response, authed);
  }

  respondError(response, 404, "E_NOT_FOUND", `No route for ${route}`);
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
  }
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
  respondJson(response, 200, { ok: true });
}

function listIssuesRoute(
  url: URL,
  response: http.ServerResponse,
  context: RequestContext,
): void {
  const issues = listIssues(context.board, {
    project: url.searchParams.get("project") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    limit: url.searchParams.has("limit")
      ? Number(url.searchParams.get("limit"))
      : undefined,
  });
  respondJson(response, 200, { issues });
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
        description: typeof body.description === "string" ? body.description : undefined,
        status: typeof body.status === "string" ? body.status : undefined,
      },
      { id: context.user!.id, kind: context.user!.role === "agent" ? "agent" : "human" },
    );

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
    await deleteIssue(context.writable, key, headerValue(request, "if-match"), actorOf(context));
    response.writeHead(204).end();
  } catch (error) {
    return handleWriteError(error, response);
  }
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
  if (error instanceof IssueError) {
    const status = error.code === "E_UNKNOWN_PROJECT" ? 404
      : error.code === "E_KEY_COLLISION" ? 409
      : 400;
    return respondError(response, status, error.code, error.message, error.detail);
  }
  throw error;
}

function showIssueRoute(
  key: string,
  response: http.ServerResponse,
  context: RequestContext,
): void {
  const found = findIssue(context.board, key);

  if (found === null) {
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
