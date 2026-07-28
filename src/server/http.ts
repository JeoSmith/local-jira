import http from "node:http";
import type { AddressInfo } from "node:net";

import { CredentialStore } from "../auth/credentials.ts";
import { createIssue, IssueError } from "../domain/issue.ts";
import {
  authenticate,
  listUsers,
  needsBootstrap,
  UserError,
  type UserRecord,
} from "../domain/users.ts";
import { canonicalJson } from "../storage/jcs.ts";
import {
  findIssue,
  listIssues,
  openBoardForWriting,
  type BoardHandle,
  type WritableBoard,
} from "../storage/board.ts";
import { formatEtag } from "../storage/resource.ts";

export const SESSION_COOKIE = "localjira_session";

export interface ServerOptions {
  cwd: string;
  host?: string;
  port?: number;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

interface RequestContext {
  writable: WritableBoard;
  board: BoardHandle;
  store: CredentialStore;
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

  const server = http.createServer((request, response) => {
    handle(request, response, { writable, board, store, user: null }).catch((error) => {
      respondError(response, 500, "E_INTERNAL", describe(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          store.close();
          void writable.close().then(resolve);
        });
      }),
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

  if (route === "GET /me") {
    return respondJson(response, 200, { user });
  }
  if (route === "GET /issues") {
    return listIssuesRoute(url, response, authed);
  }
  if (route === "POST /issues") {
    return createIssueRoute(request, response, authed);
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

    response.setHeader("ETag", formatEtag(issue.etag));
    response.setHeader("Location", `/issues/${issue.key}`);
    respondJson(response, 201, { issue });
  } catch (error) {
    if (error instanceof IssueError) {
      return respondError(response, 400, error.code, error.message, error.detail);
    }
    throw error;
  }
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

  response.setHeader("ETag", formatEtag(found.issue.etag));
  respondJson(response, 200, { issue: found.issue });
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
