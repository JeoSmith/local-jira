import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer, type RunningServer } from "../../src/server/http.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

interface Session {
  server: RunningServer;
  cookie: string;
  board: string;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
}

async function makeSession(t: { after: (fn: () => void) => void }): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-tree-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "h@example.com"]);
  git(repo, ["config", "user.name", "Tree"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo });
  cli(["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]);
  cli(["admin", "create", "--id", "owner", "--name", "오너", "--password", PASSWORD]);

  const server = await startServer({ cwd: repo, port: 0, watch: false });
  t.after(() => server.close());

  const login = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "owner", password: PASSWORD }),
  });
  assert.equal(login.status, 200);

  return {
    server,
    cookie: (login.headers.get("set-cookie") ?? "").split(";")[0],
    board: path.join(repo, ".localjira"),
  };
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
    childCount: response.headers.get("x-child-count"),
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
  };
}

interface Made {
  key: string;
  uid: string;
  etag: string;
}

async function make(
  session: Session,
  type: string,
  title: string,
  parent?: string,
): Promise<Made> {
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type, title, ...(parent === undefined ? {} : { parent }) },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return {
    key: created.json.key as unknown as string,
    uid: created.json.uid as unknown as string,
    etag: created.etag ?? "",
  };
}

async function reject(
  session: Session,
  type: string,
  parent: string,
  expected: string,
): Promise<void> {
  const attempt = await call(session, "POST", "/issues", {
    body: { project: "LJ", type, title: "안 될 것", parent },
  });
  assert.equal(attempt.status, 400, `expected 400 for ${type} under that parent`);
  assert.equal((attempt.json as unknown as { error: { code: string } }).error.code, expected);
}

test("an epic is always top level", async (t) => {
  const session = await makeSession(t);
  const epic = await make(session, "epic", "상위 에픽");

  await reject(session, "epic", epic.uid, "E_PARENT_NOT_ALLOWED");
});

test("work items hang off epics and nothing else", async (t) => {
  const session = await makeSession(t);
  const epic = await make(session, "epic", "에픽");
  const story = await make(session, "story", "스토리", epic.uid);

  assert.ok(story.key, "a story under an epic is allowed");
  await reject(session, "task", story.uid, "E_PARENT_NOT_ALLOWED");
});

test("a subtask hangs off work items, never an epic", async (t) => {
  const session = await makeSession(t);
  const epic = await make(session, "epic", "에픽");
  const story = await make(session, "story", "스토리", epic.uid);

  const subtask = await make(session, "subtask", "서브태스크", story.uid);
  assert.ok(subtask.key);

  await reject(session, "subtask", epic.uid, "E_PARENT_NOT_ALLOWED");
  // …and cannot itself be a parent, which is what keeps the tree three deep.
  await reject(session, "subtask", subtask.uid, "E_PARENT_NOT_ALLOWED");
});

test("an unknown parent is refused rather than stored as a dangling uid", async (t) => {
  const session = await makeSession(t);
  await reject(session, "story", "01JNOSUCHISSUE0000000000000", "E_PARENT_NOT_FOUND");
});

test("an issue cannot be made its own ancestor", async (t) => {
  const session = await makeSession(t);
  const epic = await make(session, "epic", "에픽");
  const story = await make(session, "story", "스토리", epic.uid);

  const itself = await call(session, "PUT", `/issues/${story.key}`, {
    ifMatch: (await call(session, "GET", `/issues/${story.key}`)).etag ?? "",
    body: { parent: story.uid },
  });
  assert.equal(itself.status, 400);
  assert.equal((itself.json as unknown as { error: { code: string } }).error.code, "E_PARENT_CYCLE");
});

test("deleting a parent with children is refused until a strategy is named", async (t) => {
  const session = await makeSession(t);
  const epic = await make(session, "epic", "삭제할 에픽");
  const first = await make(session, "story", "첫 자식", epic.uid);
  const second = await make(session, "story", "둘째 자식", epic.uid);

  const current = await call(session, "GET", `/issues/${epic.key}`);
  assert.equal(current.childCount, "2", "the detail response says there are children");

  const refused = await call(session, "DELETE", `/issues/${epic.key}`, {
    ifMatch: current.etag ?? "",
  });
  assert.equal(refused.status, 409);

  const body = refused.json as unknown as { children: string[]; strategies: string[] };
  assert.deepEqual(body.children.sort(), [first.key, second.key].sort());
  assert.deepEqual(body.strategies, ["promote", "cascade_cancel"]);

  // Nothing may have moved: the caller has not decided yet.
  assert.equal(fs.existsSync(path.join(session.board, "issues", "LJ", `${epic.key}.md`)), true);
  const child = await call(session, "GET", `/issues/${first.key}`);
  assert.equal((child.json as unknown as { parent: string }).parent, epic.uid);
});

test("promote detaches the children and then removes the parent", async (t) => {
  const session = await makeSession(t);
  const epic = await make(session, "epic", "승격 대상");
  const story = await make(session, "story", "살아남을 자식", epic.uid);

  const current = await call(session, "GET", `/issues/${epic.key}`);
  const deleted = await call(session, "DELETE", `/issues/${epic.key}?strategy=promote`, {
    ifMatch: current.etag ?? "",
  });
  assert.equal(deleted.status, 204);

  assert.equal(fs.existsSync(path.join(session.board, "issues", "LJ", `${epic.key}.md`)), false);

  const survivor = await call(session, "GET", `/issues/${story.key}`);
  assert.equal(survivor.status, 200);
  assert.equal(
    (survivor.json as unknown as { parent?: string }).parent,
    undefined,
    "the child is top level now, not pointing at a file that is gone",
  );
});

test("promote refuses when it would strand a subtask", async (t) => {
  const session = await makeSession(t);
  const epic = await make(session, "epic", "에픽");
  const story = await make(session, "story", "부모가 될 스토리", epic.uid);
  const subtask = await make(session, "subtask", "서브태스크", story.uid);

  const current = await call(session, "GET", `/issues/${story.key}`);
  const refused = await call(session, "DELETE", `/issues/${story.key}?strategy=promote`, {
    ifMatch: current.etag ?? "",
  });

  // A parentless subtask is a shape the create path rejects outright, so
  // producing one here would leave the index holding something the API could
  // never have made.
  assert.equal(refused.status, 409);
  assert.equal(
    (refused.json as unknown as { error: { code: string } }).error.code,
    "E_STRATEGY_IMPOSSIBLE",
  );

  const untouched = await call(session, "GET", `/issues/${subtask.key}`);
  assert.equal(untouched.status, 200);
  assert.equal((untouched.json as unknown as { parent: string }).parent, story.uid);
});

test("cascade_cancel cancels the children and then removes the parent", async (t) => {
  const session = await makeSession(t);
  const epic = await make(session, "epic", "에픽");
  const story = await make(session, "story", "스토리", epic.uid);
  const subtask = await make(session, "subtask", "서브태스크", story.uid);

  const current = await call(session, "GET", `/issues/${story.key}`);
  const deleted = await call(session, "DELETE", `/issues/${story.key}?strategy=cascade_cancel`, {
    ifMatch: current.etag ?? "",
  });
  assert.equal(deleted.status, 204, JSON.stringify(deleted.json));

  const cancelled = await call(session, "GET", `/issues/${subtask.key}`);
  assert.equal(cancelled.status, 200, "the child survives as a record");
  assert.equal((cancelled.json as unknown as { status: string }).status, "CANCELLED");
  assert.equal(fs.existsSync(path.join(session.board, "issues", "LJ", `${story.key}.md`)), false);

  // The three assertions above all passed while the cascade left every child
  // pointing at the deleted parent, because a quarantined issue still answers
  // GET from its last good row and its status still reads CANCELLED. What none
  // of them looked at was the board.
  const file = fs.readFileSync(
    path.join(session.board, "issues", "LJ", `${subtask.key}.md`),
    "utf8",
  );
  assert.equal(/^parent:/m.test(file), false, "the child must not name a deleted parent");

  const integrity = await call(session, "GET", "/integrity/issues");
  assert.deepEqual(
    (integrity.json as unknown as { quarantined: unknown[] }).quarantined,
    [],
    "cascade_cancel must not leave the board holding an INVALID issue",
  );
});

test("an unknown strategy is refused rather than treated as none", async (t) => {
  const session = await makeSession(t);
  const epic = await make(session, "epic", "에픽");
  await make(session, "story", "자식", epic.uid);

  const current = await call(session, "GET", `/issues/${epic.key}`);
  const refused = await call(session, "DELETE", `/issues/${epic.key}?strategy=obliterate`, {
    ifMatch: current.etag ?? "",
  });
  assert.equal(refused.status, 400);
  assert.equal(
    (refused.json as unknown as { error: { code: string } }).error.code,
    "E_INVALID_STRATEGY",
  );
});

test("the children of an issue are their own resource", async (t) => {
  const session = await makeSession(t);
  const epic = await make(session, "epic", "에픽");
  const story = await make(session, "story", "스토리", epic.uid);

  const listed = await call(session, "GET", `/issues/${epic.key}/children`);
  assert.equal(listed.status, 200);

  const children = (listed.json as unknown as {
    children: Array<{ key: string; title: string; status: string; type: string }>;
  }).children;
  assert.equal(children.length, 1);
  assert.equal(children[0].key, story.key);
  assert.equal(children[0].title, "스토리", "enough to render a subtask row without another call");
  assert.equal(children[0].status, "BACKLOG");

  // Reparenting somebody else onto this epic must not move the epic's ETag:
  // the body is the file, and the file did not change.
  const before = await call(session, "GET", `/issues/${epic.key}`);
  await make(session, "task", "나중에 붙는 자식", epic.uid);
  const after = await call(session, "GET", `/issues/${epic.key}`);
  assert.equal(after.etag, before.etag, "a derived list must not perturb the validator");
  assert.equal(after.childCount, "2");
});
