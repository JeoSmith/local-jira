import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { allowedTargets, requiresAdmin, STATUSES } from "../../src/domain/transition.ts";
import { bootstrapAdmin, createUser } from "../../src/domain/users.ts";
import { startServer, type RunningServer } from "../../src/server/http.ts";
import { openBoardForWriting } from "../../src/storage/board.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout;
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-trans-")));
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
  await board.close();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { repo, board: path.join(repo, ".localjira") };
}

interface Session {
  server: RunningServer;
  cookie: string;
}

async function signIn(sandbox: Sandbox, id = "admin"): Promise<Session> {
  const server = await startServer({ cwd: sandbox.repo, port: 0 });
  const response = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  return { server, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] };
}

async function call(
  session: Session,
  method: string,
  route: string,
  options: { body?: unknown; ifMatch?: string } = {},
) {
  const response = await fetch(`${session.server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: session.cookie,
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

async function seed(session: Session): Promise<{ key: string; etag: string }> {
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "story", title: "전이 대상" },
  });
  assert.equal(created.status, 201);
  return { key: created.json.key as unknown as string, etag: created.etag ?? "" };
}

/** Walks the issue to a status through legal moves. */
async function moveTo(session: Session, key: string, target: string): Promise<string> {
  const routes: Record<string, string[]> = {
    TODO: ["TODO"],
    IN_PROGRESS: ["TODO", "IN_PROGRESS"],
    IN_REVIEW: ["TODO", "IN_PROGRESS", "IN_REVIEW"],
    DONE: ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"],
    CANCELLED: ["CANCELLED"],
  };
  let etag = (await call(session, "GET", `/issues/${key}`)).etag ?? "";
  for (const step of routes[target] ?? []) {
    const moved = await call(session, "POST", `/issues/${key}/transitions`, {
      ifMatch: etag,
      body: { to: step },
    });
    assert.equal(moved.status, 200, `${step}: ${JSON.stringify(moved.json)}`);
    etag = moved.etag ?? "";
  }
  return etag;
}

// ── the table itself ────────────────────────────────────────────────────────

test("the transition table is an allow-list", () => {
  assert.deepEqual(allowedTargets("BACKLOG", null), ["TODO", "BLOCKED", "CANCELLED"]);
  assert.deepEqual(allowedTargets("DONE", null), ["IN_PROGRESS"]);
  assert.deepEqual(allowedTargets("CANCELLED", null), ["BACKLOG"]);

  // BLOCKED returns only to what it interrupted, so the row depends on the
  // issue rather than being fixed.
  assert.deepEqual(allowedTargets("BLOCKED", "IN_PROGRESS"), ["IN_PROGRESS", "CANCELLED"]);
  assert.deepEqual(allowedTargets("BLOCKED", null), ["CANCELLED"]);

  assert.equal(requiresAdmin("CANCELLED", "BACKLOG"), true);
  assert.equal(requiresAdmin("TODO", "IN_PROGRESS"), false);

  // Every status is reachable from somewhere, or it would be dead weight.
  const reachable = new Set(STATUSES.flatMap((from) => allowedTargets(from, "IN_PROGRESS")));
  for (const status of STATUSES) {
    if (status !== "BACKLOG") {
      assert.ok(reachable.has(status), `${status} is unreachable`);
    }
  }
});

// ── over HTTP ───────────────────────────────────────────────────────────────

test("walks the happy path and refuses the shortcuts", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key, etag } = await seed(session);

  const skipping = await call(session, "POST", `/issues/${key}/transitions`, {
    ifMatch: etag,
    body: { to: "IN_PROGRESS" },
  });
  assert.equal(skipping.status, 400, "BACKLOG → IN_PROGRESS is not in the table");
  assert.equal(skipping.json.error.code as unknown as string, "E_TRANSITION_NOT_ALLOWED");
  assert.deepEqual(skipping.json.allowed as unknown as string[], ["TODO", "BLOCKED", "CANCELLED"]);

  const unchanged = await call(session, "GET", `/issues/${key}`);
  assert.equal(unchanged.etag, etag, "a refused transition must not touch the file");

  const done = await moveTo(session, key, "DONE");
  assert.equal(
    ((await call(session, "GET", `/issues/${key}`)).json as unknown as Record<string, unknown>).status,
    "DONE",
  );

  const reopened = await call(session, "POST", `/issues/${key}/transitions`, {
    ifMatch: done,
    body: { to: "IN_PROGRESS" },
  });
  assert.equal(reopened.status, 200, "reopening is the one way out of DONE");

  const backwards = await call(session, "POST", `/issues/${key}/transitions`, {
    ifMatch: reopened.etag ?? "",
    body: { to: "DONE" },
  });
  assert.equal(backwards.status, 400, "IN_PROGRESS → DONE skips review");
});

test("blocking remembers where the work was", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key } = await seed(session);
  const inProgress = await moveTo(session, key, "IN_PROGRESS");

  const blocked = await call(session, "POST", `/issues/${key}/transitions`, {
    ifMatch: inProgress,
    body: { to: "BLOCKED", reason: "외부 의존" },
  });
  assert.equal(blocked.status, 200);
  const blockedDoc = blocked.json as unknown as Record<string, unknown>;
  assert.equal(blockedDoc.status, "BLOCKED");
  assert.equal(blockedDoc.blocked_from, "IN_PROGRESS");

  const wrongWayBack = await call(session, "POST", `/issues/${key}/transitions`, {
    ifMatch: blocked.etag ?? "",
    body: { to: "TODO" },
  });
  assert.equal(wrongWayBack.status, 400, "BLOCKED returns only to where it came from");

  const resumed = await call(session, "POST", `/issues/${key}/transitions`, {
    ifMatch: blocked.etag ?? "",
    body: { to: "IN_PROGRESS" },
  });
  assert.equal(resumed.status, 200);
  const resumedDoc = resumed.json as unknown as Record<string, unknown>;
  assert.equal(resumedDoc.status, "IN_PROGRESS");
  assert.equal(
    Object.prototype.hasOwnProperty.call(resumedDoc, "blocked_from"),
    false,
    "a stale marker would offer a return path the issue no longer has",
  );
});

test("only an admin may revive a cancelled issue", async (t) => {
  const sandbox = await makeSandbox(t);

  const member = await signIn(sandbox, "dev");
  const { key } = await seed(member);
  const cancelled = await moveTo(member, key, "CANCELLED");

  const refused = await call(member, "POST", `/issues/${key}/transitions`, {
    ifMatch: cancelled,
    body: { to: "BACKLOG" },
  });
  // 403, not 400: the move exists, this role may not make it.
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code as unknown as string, "E_TRANSITION_FORBIDDEN");
  await member.server.close();

  const admin = await signIn(sandbox, "admin");
  t.after(() => admin.server.close());
  const revived = await call(admin, "POST", `/issues/${key}/transitions`, {
    ifMatch: cancelled,
    body: { to: "BACKLOG" },
  });
  assert.equal(revived.status, 200);
});

test("a transition needs If-Match like any other write", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key, etag } = await seed(session);

  const noHeader = await call(session, "POST", `/issues/${key}/transitions`, { body: { to: "TODO" } });
  assert.equal(noHeader.status, 428);

  await call(session, "POST", `/issues/${key}/transitions`, { ifMatch: etag, body: { to: "TODO" } });
  const stale = await call(session, "POST", `/issues/${key}/transitions`, {
    ifMatch: etag,
    body: { to: "IN_PROGRESS" },
  });
  assert.equal(stale.status, 412);
});

test("refuses an unknown status without touching the issue", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key, etag } = await seed(session);
  const nonsense = await call(session, "POST", `/issues/${key}/transitions`, {
    ifMatch: etag,
    body: { to: "SHIPPED" },
  });

  assert.equal(nonsense.status, 400);
  assert.equal(nonsense.json.error.code as unknown as string, "E_INVALID_STATUS");
  assert.equal((await call(session, "GET", `/issues/${key}`)).etag, etag);
});

// ── immutable fields and deletion ───────────────────────────────────────────

test("refuses to rewrite server-owned fields", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key, etag } = await seed(session);

  for (const field of ["uid", "key", "created_at", "created_by_kind"]) {
    const rejected = await call(session, "PUT", `/issues/${key}`, {
      ifMatch: etag,
      body: { [field]: "somethingElse" },
    });
    assert.equal(rejected.status, 400, field);
    assert.equal(rejected.json.error.code as unknown as string, "E_IMMUTABLE_FIELD");
  }
  assert.equal((await call(session, "GET", `/issues/${key}`)).etag, etag);
});

test("deletes an issue and removes it from the board", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key, etag } = await seed(session);
  const file = path.join(sandbox.board, "issues", "LJ", `${key}.md`);
  assert.equal(fs.existsSync(file), true);

  const deleted = await call(session, "DELETE", `/issues/${key}`, { ifMatch: etag });
  assert.equal(deleted.status, 204);
  assert.equal(fs.existsSync(file), false);

  assert.equal((await call(session, "GET", `/issues/${key}`)).status, 404);
  assert.equal((await call(session, "GET", "/issues")).json.issues.length, 0);
});

test("a delete needs If-Match too", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key } = await seed(session);

  assert.equal((await call(session, "DELETE", `/issues/${key}`)).status, 428);
  assert.equal(
    (await call(session, "DELETE", `/issues/${key}`, { ifMatch: `"${"0".repeat(64)}"` })).status,
    412,
  );
  assert.equal(fs.existsSync(path.join(sandbox.board, "issues", "LJ", `${key}.md`)), true);
});

test("refuses to delete a parent that still has children", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const parent = await seed(session);
  const parentDoc = (await call(session, "GET", `/issues/${parent.key}`)).json as unknown as Record<string, unknown>;

  // r02a owns promote/cascade_cancel; until then the parent simply cannot go.
  const child = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title: "자식" },
  });
  const childFile = path.join(sandbox.board, "issues", "LJ", `${child.json.key as unknown as string}.md`);
  fs.writeFileSync(
    childFile,
    fs.readFileSync(childFile, "utf8").replace("status: BACKLOG", `status: BACKLOG\nparent: ${parentDoc.uid as string}`),
  );
  await session.server.close();

  const reopened = await signIn(sandbox);
  t.after(() => reopened.server.close());
  const current = await call(reopened, "GET", `/issues/${parent.key}`);

  const refused = await call(reopened, "DELETE", `/issues/${parent.key}`, {
    ifMatch: current.etag ?? "",
  });
  assert.equal(refused.status, 409);
  assert.equal(fs.existsSync(path.join(sandbox.board, "issues", "LJ", `${parent.key}.md`)), true);
});
