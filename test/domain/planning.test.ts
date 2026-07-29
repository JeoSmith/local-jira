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
  owner: string;
  board: string;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout;
}

function cli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

async function makeSession(t: { after: (fn: () => void) => void }): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-plan-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "n@example.com"]);
  git(repo, ["config", "user.name", "Plan"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]);
  cli(repo, ["admin", "create", "--id", "owner", "--name", "오너", "--password", PASSWORD]);

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
    owner: (login.headers.get("set-cookie") ?? "").split(";")[0],
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
      cookie: session.owner,
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

const START = "2026-08-03T09:00:00+09:00";
const END = "2026-08-17T18:00:00+09:00";

async function makeSprint(session: Session, capacity: number | null = 24): Promise<string> {
  const created = await call(session, "POST", "/projects/LJ/sprints", {
    body: { name: "S", start_at: START, end_at: END, ...(capacity === null ? {} : { capacity }) },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.id as unknown as string;
}

async function makeIssue(
  session: Session,
  title: string,
  points?: number,
): Promise<{ key: string; etag: string }> {
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title, ...(points === undefined ? {} : { points }) },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return { key: created.json.key as unknown as string, etag: created.etag ?? "" };
}

async function put(
  session: Session,
  key: string,
  body: Record<string, unknown>,
): Promise<ReturnType<typeof call> extends Promise<infer T> ? T : never> {
  const current = await call(session, "GET", `/issues/${key}`);
  return call(session, "PUT", `/issues/${key}`, { ifMatch: current.etag ?? "", body });
}

test("an issue moves into a sprint and back, keeping its backlog position", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const first = await makeIssue(session, "첫째", 5);
  const second = await makeIssue(session, "둘째", 3);

  const before = await call(session, "GET", `/issues/${second.key}`);
  const rank = (before.json as unknown as { backlog_rank: string }).backlog_rank;

  const moved = await put(session, second.key, { sprint });
  assert.equal(moved.status, 200);
  assert.equal((moved.json as unknown as { sprint: string }).sprint, sprint);

  const returned = await put(session, second.key, { sprint: null });
  assert.equal(returned.status, 200);
  assert.equal((returned.json as unknown as { sprint?: string }).sprint, undefined);

  // ADR-005 §1: leaving a sprint must put the issue back where it was in the
  // backlog, which is why the two ranks are separate fields in the first place.
  assert.equal((returned.json as unknown as { backlog_rank: string }).backlog_rank, rank);
  void first;
});

test("a closed sprint refuses new work; an unknown one is refused outright", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const issue = await makeIssue(session, "이슈", 3);

  // Closing is r05b's command; for now set the file directly, which is how a
  // merge would deliver a closed sprint anyway.
  const file = path.join(session.board, "sprints", "LJ", `${sprint}.yaml`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^status: .*$/m, "status: CLOSED"));
  await session.server.reconcile();

  const closed = await put(session, issue.key, { sprint });
  assert.equal(closed.status, 400, JSON.stringify(closed.json));
  assert.equal(
    (closed.json as unknown as { error: { code: string } }).error.code,
    "E_SPRINT_CLOSED",
  );

  const unknown = await put(session, issue.key, { sprint: "LJ-S99" });
  assert.equal(unknown.status, 400);
  assert.equal(
    (unknown.json as unknown as { error: { code: string } }).error.code,
    "E_UNKNOWN_SPRINT",
  );

  // Neither attempt may have touched the issue.
  const untouched = await call(session, "GET", `/issues/${issue.key}`);
  assert.equal((untouched.json as unknown as { sprint?: string }).sprint, undefined);
});

test("the plan counts points and keeps unestimated issues visible", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session, 24);

  for (const points of [5, 8, 3]) {
    const issue = await makeIssue(session, `추정 ${points}`, points);
    await put(session, issue.key, { sprint });
  }
  const unestimated = await makeIssue(session, "무추정");
  await put(session, unestimated.key, { sprint });

  const plan = await call(session, "GET", `/sprints/${sprint}/plan`);
  const body = plan.json as unknown as {
    committed: number; capacity: number; unestimated: number; issues: number; over: number;
  };

  assert.equal(body.committed, 16);
  assert.equal(body.capacity, 24);
  assert.equal(body.over, 0, "16 of 24 is not over");
  assert.equal(body.issues, 4);
  // Reported, not folded in as zero: a total that silently covered only the
  // sized part of the scope would read as though it covered all of it (D8).
  assert.equal(body.unestimated, 1);
});

test("exceeding capacity warns and blocks nothing", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session, 24);

  for (const points of [5, 8, 3]) {
    const issue = await makeIssue(session, `${points}점`, points);
    await put(session, issue.key, { sprint });
  }

  const overflowing = await makeIssue(session, "13점", 13);
  const added = await put(session, overflowing.key, { sprint });

  // PRD R6 and AC5: the warning is a warning. A tool that refuses to record
  // what a team decided to attempt is describing a different team.
  assert.equal(added.status, 200, "adding past capacity still succeeds");

  const plan = await call(session, "GET", `/sprints/${sprint}/plan`);
  const body = plan.json as unknown as { committed: number; capacity: number; over: number };
  assert.equal(body.committed, 29);
  assert.equal(body.over, 5, "the overshoot is reported so a screen can warn");
});

test("a sprint with no capacity reports a total and no verdict", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session, null);
  const issue = await makeIssue(session, "이슈", 8);
  await put(session, issue.key, { sprint });

  const plan = await call(session, "GET", `/sprints/${sprint}/plan`);
  const body = plan.json as unknown as { committed: number; capacity: number | null; over: number | null };
  assert.equal(body.committed, 8);
  assert.equal(body.capacity, null);
  assert.equal(body.over, null, "nothing to be over");
});

test("several issues move in one request, each as its own write", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const keys: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    keys.push((await makeIssue(session, `이슈 ${index}`, 2)).key);
  }

  git(session.board, ["add", "-A"]);
  git(session.board, ["-c", "user.email=n@e.com", "-c", "user.name=N", "commit", "-qm", "before"]);

  const moved = await call(session, "POST", `/sprints/${sprint}/issues`, { body: { keys } });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.deepEqual((moved.json as unknown as { moved: string[] }).moved.sort(), [...keys].sort());

  // Five issues, five files — the batch is a convenience, not a transaction.
  const changed = git(session.board, ["status", "--porcelain"])
    .split("\n")
    .filter((line) => line.includes("issues/"));
  assert.equal(changed.length, 5);

  const plan = await call(session, "GET", `/sprints/${sprint}/plan`);
  assert.equal((plan.json as unknown as { committed: number }).committed, 10);
});

test("a partial batch reports what moved and what did not", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const real = await makeIssue(session, "진짜", 3);

  const result = await call(session, "POST", `/sprints/${sprint}/issues`, {
    body: { keys: [real.key, "LJ-9999"] },
  });

  // 207: pretending the whole thing succeeded or failed would contradict the
  // files, which is where the truth is.
  assert.equal(result.status, 207);
  const body = result.json as unknown as {
    moved: string[];
    failed: Array<{ key: string; code: string }>;
  };
  assert.deepEqual(body.moved, [real.key]);
  assert.equal(body.failed[0].key, "LJ-9999");
});

test("moving back to the backlog is the same endpoint", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const issue = await makeIssue(session, "왕복", 5);

  await call(session, "POST", `/sprints/${sprint}/issues`, { body: { keys: [issue.key] } });
  assert.equal((await call(session, "GET", `/sprints/${sprint}/plan`)).json.committed as unknown as number, 5);

  const released = await call(session, "POST", "/sprints/backlog/issues", {
    body: { keys: [issue.key] },
  });
  assert.equal(released.status, 200);
  assert.equal((await call(session, "GET", `/sprints/${sprint}/plan`)).json.committed as unknown as number, 0);
});

test("a finished issue may stay in the sprint it was finished in", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const issue = await makeIssue(session, "끝난 일", 5);
  await put(session, issue.key, { sprint });

  for (const to of ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]) {
    const current = await call(session, "GET", `/issues/${issue.key}`);
    const moved = await call(session, "POST", `/issues/${issue.key}/transitions`, {
      ifMatch: current.etag ?? "",
      body: { to },
    });
    assert.equal(moved.status, 200, `could not move to ${to}`);
  }

  // R20 excludes CANCELLED and unestimated issues from the burndown denominator,
  // which only makes sense if such issues can be in scope at all. Removing
  // finished work from a sprint would also erase what the sprint achieved.
  const plan = await call(session, "GET", `/sprints/${sprint}/plan`);
  assert.equal((plan.json as unknown as { committed: number }).committed, 5);
});

test("a subtask may sit in a different sprint from its parent", async (t) => {
  const session = await makeSession(t);
  const first = await makeSprint(session);
  const second = await makeSprint(session);

  const epic = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "epic", title: "에픽" },
  });
  const story = await call(session, "POST", "/issues", {
    body: {
      project: "LJ", type: "story", title: "스토리",
      parent: epic.json.uid as unknown as string,
    },
  });
  const subtask = await call(session, "POST", "/issues", {
    body: {
      project: "LJ", type: "subtask", title: "서브태스크",
      parent: story.json.uid as unknown as string,
    },
  });

  await put(session, story.json.key as unknown as string, { sprint: first });
  const split = await put(session, subtask.json.key as unknown as string, { sprint: second });

  // Sprint membership is not inherited. Coupling them would make one drag
  // rewrite several files and quietly move work nobody pointed at — and a story
  // genuinely can span two sprints while one of its subtasks lands in the second.
  assert.equal(split.status, 200);
  assert.equal((split.json as unknown as { sprint: string }).sprint, second);

  const parent = await call(session, "GET", `/issues/${story.json.key as unknown as string}`);
  assert.equal((parent.json as unknown as { sprint: string }).sprint, first, "the parent did not move");
});

test("a sprint move is recorded with both sides", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const issue = await makeIssue(session, "기록될 이동", 3);
  await put(session, issue.key, { sprint });

  const timeline = await call(session, "GET", `/issues/${issue.key}/activity`);
  const entries = (timeline.json as unknown as {
    entries: Array<{ verb: string; before: unknown; after: unknown }>;
  }).entries;

  const move = entries.find(
    (entry) => entry.verb === "issue.updated" && JSON.stringify(entry.after).includes("sprint"),
  );
  assert.ok(move, `no sprint change in ${JSON.stringify(entries.map((e) => e.verb))}`);
  assert.deepEqual(move.before, { sprint: null });
  assert.deepEqual(move.after, { sprint });
});
