import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { can, capabilitiesOf } from "../../src/auth/authorize.ts";
import {
  bootstrapAdmin,
  changeRole,
  createUser,
  invalidUsers,
  listUsers,
  UserError,
} from "../../src/domain/users.ts";
import { startServer, type RunningServer } from "../../src/server/http.ts";
import { openBoardForWriting } from "../../src/storage/board.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
}

function cli(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

interface Sandbox {
  repo: string;
  board: string;
}

async function makeSandbox(t: { after: (fn: () => void) => void }): Promise<Sandbox> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-authz-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
  cli(repo, ["init", "--project-key", "LJ", "--project-name", "Local Jira", "--timezone", "Asia/Seoul"]);

  const board = await openBoardForWriting(repo);
  bootstrapAdmin(board.board, { id: "admin", displayName: "관리자", password: PASSWORD });
  createUser(board.board, { id: "dev", displayName: "개발자", role: "member", password: PASSWORD });
  createUser(board.board, { id: "bot", displayName: "에이전트", role: "agent", password: PASSWORD });
  await board.close();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { repo, board: path.join(repo, ".localjira") };
}

interface Session {
  server: RunningServer;
  cookie: string;
}

async function signIn(sandbox: Sandbox, id: string): Promise<Session> {
  const server = await startServer({ cwd: sandbox.repo, port: 0 });
  const response = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, password: PASSWORD }),
  });
  assert.equal(response.status, 200, `${id} could not sign in`);
  return { server, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] };
}

async function call(
  session: Session,
  method: string,
  route: string,
  options: { body?: unknown; ifMatch?: string; cookie?: string } = {},
) {
  const cookie = options.cookie === undefined ? session.cookie : options.cookie;
  const response = await fetch(`${session.server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(options.ifMatch === undefined ? {} : { "if-match": options.ifMatch }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
  };
}

// ── the capability table ────────────────────────────────────────────────────

test("roles differ on operating the board, not on using it", () => {
  for (const capability of ["issue:write", "issue:delete", "issue:rank", "claim:release"] as const) {
    assert.equal(can("admin", capability), true, capability);
    assert.equal(can("member", capability), true, capability);
  }

  // Only an admin manages who the users are.
  assert.equal(can("member", "user:manage"), false);
  assert.equal(can("member", "token:manage"), false);
  assert.equal(can("admin", "user:manage"), true);

  // An agent's session grants reading only; its writes are authorised by token
  // scope instead (D9), and a second weaker gate here would override that.
  assert.deepEqual(capabilitiesOf("agent"), ["issue:read"]);
});

// ── role loading ────────────────────────────────────────────────────────────

test("refuses to load an account with a role outside the three", async (t) => {
  const sandbox = await makeSandbox(t);
  const usersFile = path.join(sandbox.board, "users.yaml");
  fs.writeFileSync(
    usersFile,
    fs.readFileSync(usersFile, "utf8").replace("role: agent", "role: superuser"),
  );

  const board = await openBoardForWriting(sandbox.repo);
  t.after(() => board.close());

  // Defaulting the unknown role would either grant or withhold permission on
  // the strength of a typo.
  assert.deepEqual(listUsers(board.board).map((user) => user.id), ["admin", "dev"]);
  assert.deepEqual(invalidUsers(board.board), [{ id: "bot", role: "superuser" }]);
});

test("keeps the board from losing its last admin", async (t) => {
  const sandbox = await makeSandbox(t);
  const board = await openBoardForWriting(sandbox.repo);
  t.after(() => board.close());

  assert.throws(
    () => changeRole(board.board, "admin", "member"),
    (error: unknown) => {
      assert.ok(error instanceof UserError);
      assert.equal(error.code, "E_LAST_ADMIN");
      return true;
    },
  );

  // With a second admin in place the demotion is allowed.
  changeRole(board.board, "dev", "admin");
  const change = changeRole(board.board, "admin", "member");
  assert.deepEqual(change, { from: "admin", to: "member" });
  assert.equal(listUsers(board.board).filter((user) => user.role === "admin").length, 1);
});

// ── over HTTP ───────────────────────────────────────────────────────────────

test("a member may do everything to issues", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, "dev");
  t.after(() => session.server.close());

  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "story", title: "member가 만든 이슈" },
  });
  assert.equal(created.status, 201);
  const key = created.json.key as unknown as string;

  const updated = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: created.etag ?? "",
    body: { points: 5 },
  });
  assert.equal(updated.status, 200);

  const moved = await call(session, "POST", `/issues/${key}/transitions`, {
    ifMatch: updated.etag ?? "",
    body: { to: "TODO" },
  });
  assert.equal(moved.status, 200);

  // S1-D11: deletion is a member capability. The event names who did it and
  // the file is in git, so it is visible and reversible.
  const deleted = await call(session, "DELETE", `/issues/${key}`, { ifMatch: moved.etag ?? "" });
  assert.equal(deleted.status, 204);
});

test("a member may not manage accounts", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, "dev");
  t.after(() => session.server.close());

  const created = await call(session, "POST", "/users", {
    body: { id: "newbie", display_name: "신규", role: "member", password: PASSWORD },
  });
  assert.equal(created.status, 403);
  assert.equal(created.json.error.code as unknown as string, "E_FORBIDDEN");

  const promoted = await call(session, "PUT", "/users/dev/role", { body: { role: "admin" } });
  assert.equal(promoted.status, 403);

  // Nothing changed on disk.
  assert.equal(
    fs.readFileSync(path.join(sandbox.board, "users.yaml"), "utf8").includes("newbie"),
    false,
  );
});

test("an admin may manage accounts", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, "admin");
  t.after(() => session.server.close());

  const created = await call(session, "POST", "/users", {
    body: { id: "newbie", display_name: "신규", role: "member", password: PASSWORD },
  });
  assert.equal(created.status, 201);

  const promoted = await call(session, "PUT", "/users/newbie/role", { body: { role: "admin" } });
  assert.equal(promoted.status, 200);
  assert.deepEqual(
    { from: promoted.json.from, to: promoted.json.to },
    { from: "member", to: "admin" },
  );
});

test("distinguishes not signed in from not allowed", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, "dev");
  t.after(() => session.server.close());

  const anonymous = await call(session, "POST", "/users", {
    cookie: "",
    body: { id: "x", display_name: "x", role: "member", password: PASSWORD },
  });
  const signedIn = await call(session, "POST", "/users", {
    body: { id: "x", display_name: "x", role: "member", password: PASSWORD },
  });

  // 401 means "identify yourself"; 403 means "you did, and it is not enough".
  // Collapsing them would send a member back to the login page for ever.
  assert.equal(anonymous.status, 401);
  assert.equal(signedIn.status, 403);
});

test("a role change takes effect without signing in again", async (t) => {
  const sandbox = await makeSandbox(t);
  const member = await signIn(sandbox, "dev");
  t.after(() => member.server.close());

  const before = await call(member, "POST", "/users", {
    body: { id: "newbie", display_name: "신규", role: "member", password: PASSWORD },
  });
  assert.equal(before.status, 403);

  // Promote through the same server, then reuse the *existing* session.
  const board = member.server;
  const adminCookie = (await (async () => {
    const response = await fetch(`${board.url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "admin", password: PASSWORD }),
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0];
  })());

  const promoted = await call(member, "PUT", "/users/dev/role", {
    cookie: adminCookie,
    body: { role: "admin" },
  });
  assert.equal(promoted.status, 200);

  const after = await call(member, "POST", "/users", {
    body: { id: "newbie", display_name: "신규", role: "member", password: PASSWORD },
  });
  assert.equal(after.status, 201, "the role is read per request, not cached in the session");
});

test("an agent session cannot write; its scope decides that later", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, "bot");
  t.after(() => session.server.close());

  const read = await call(session, "GET", "/issues");
  assert.equal(read.status, 200);

  const written = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "story", title: "에이전트가 쓴 이슈" },
  });
  assert.equal(written.status, 403);
  assert.match(written.json.error.detail as unknown as string, /issue:write/);
});
