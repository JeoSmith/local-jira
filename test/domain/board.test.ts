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
  repo: string;
  board: string;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
}

function cli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

async function makeSession(t: { after: (fn: () => void) => void }): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-board-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "b@example.com"]);
  git(repo, ["config", "user.name", "Board"]);
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
    cookie: (login.headers.get("set-cookie") ?? "").split(";")[0],
    repo,
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
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
  };
}

async function makeSprint(session: Session, capacity: number | null = 24): Promise<string> {
  const created = await call(session, "POST", "/projects/LJ/sprints", {
    body: {
      name: "S", start_at: "2026-08-03T09:00:00+09:00", end_at: "2026-08-17T18:00:00+09:00",
      ...(capacity === null ? {} : { capacity }),
    },
  });
  assert.equal(created.status, 201);
  return created.json.id as unknown as string;
}

async function makeIssue(session: Session, title: string, points?: number): Promise<string> {
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title, ...(points === undefined ? {} : { points }) },
  });
  assert.equal(created.status, 201);
  return created.json.key as unknown as string;
}

/**
 * Creates an issue as an agent, which needs a token: the CLI and the API both
 * take the actor from one now (r13c), and there is no other way to be an agent.
 */
async function makeAgentIssue(session: Session, title: string): Promise<string> {
  cli(session.repo, [
    "admin", "create", "--id", "bot", "--name", "봇", "--password", PASSWORD, "--role", "agent",
  ]);
  const issued = cli(session.repo, [
    "token", "create", "--user", "bot", "--password", PASSWORD,
    "--scope", "issue:read", "--scope", "issue:edit",
  ]);
  assert.equal(issued.status, 0, issued.stderr);
  await session.server.reconcile();

  const created = await fetch(`${session.server.url}/issues`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${issued.stdout.trim()}`,
    },
    body: JSON.stringify({ project: "LJ", type: "task", title, points: 3 }),
  });
  const body = (await created.json()) as { key: string };
  assert.equal(created.status, 201, JSON.stringify(body));
  return body.key;
}

async function put(session: Session, key: string, body: Record<string, unknown>) {
  const current = await call(session, "GET", `/issues/${key}`);
  return call(session, "PUT", `/issues/${key}`, { ifMatch: current.etag ?? "", body });
}

async function moveTo(session: Session, key: string, target: string): Promise<void> {
  const route: Record<string, string[]> = {
    TODO: ["TODO"],
    IN_PROGRESS: ["TODO", "IN_PROGRESS"],
    BLOCKED: ["TODO", "IN_PROGRESS", "BLOCKED"],
    DONE: ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"],
  };
  for (const to of route[target]) {
    const current = await call(session, "GET", `/issues/${key}`);
    const moved = await call(session, "POST", `/issues/${key}/transitions`, {
      ifMatch: current.etag ?? "",
      body: { to },
    });
    assert.equal(moved.status, 200, `could not move ${key} to ${to}`);
  }
}

test("the board shows the active sprint's scope and nothing else", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const other = await makeSprint(session);

  const inScope = await makeIssue(session, "이번 스프린트", 5);
  const elsewhere = await makeIssue(session, "다음 스프린트", 3);
  const backlog = await makeIssue(session, "백로그", 8);

  await put(session, inScope, { sprint });
  await put(session, elsewhere, { sprint: other });
  await call(session, "POST", `/sprints/${sprint}/start`);

  const board = await call(session, "GET", "/projects/LJ/board");
  assert.equal(board.status, 200);
  const body = board.json as unknown as {
    sprint: { id: string };
    issues: Array<{ key: string }>;
    plan: { committed: number };
  };

  assert.equal(body.sprint.id, sprint);
  assert.deepEqual(body.issues.map((issue) => issue.key), [inScope]);
  assert.equal(body.plan.committed, 5);
  void backlog;
});

test("no active sprint is an empty board, not an error", async (t) => {
  const session = await makeSession(t);
  await makeIssue(session, "이슈", 3);

  const board = await call(session, "GET", "/projects/LJ/board");
  // A project between sprints is an ordinary state, and answering with an error
  // would make a normal moment look like a fault.
  assert.equal(board.status, 200);
  const body = board.json as unknown as { sprint: null; reason: string; issues: unknown[] };
  assert.equal(body.sprint, null);
  assert.equal(body.reason, "no_active_sprint");
  assert.deepEqual(body.issues, []);
});

test("a sprint conflict is a different empty board from no sprint", async (t) => {
  const session = await makeSession(t);
  const first = await makeSprint(session);
  const second = await makeSprint(session);
  await call(session, "POST", `/sprints/${first}/start`);

  const file = path.join(session.board, "sprints", "LJ", `${second}.yaml`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^status: .*$/m, "status: ACTIVE"));
  await session.server.reconcile();

  const board = await call(session, "GET", "/projects/LJ/board");
  const body = board.json as unknown as { sprint: null; reason: string; sprintConflicts: string[] };

  // "No sprint is running" and "the board cannot tell which is running" need
  // different things from a person: one is a start command, the other is a file
  // to repair.
  assert.equal(body.reason, "sprint_conflict");
  assert.deepEqual(body.sprintConflicts, ["LJ"]);
});

test("columns carry their own count and points", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);

  const todo = await makeIssue(session, "할 일", 5);
  const doing = await makeIssue(session, "하는 중", 8);
  const done = await makeIssue(session, "끝난 것", 3);
  for (const key of [todo, doing, done]) {
    await put(session, key, { sprint });
  }
  await call(session, "POST", `/sprints/${sprint}/start`);
  await moveTo(session, todo, "TODO");
  await moveTo(session, doing, "IN_PROGRESS");
  await moveTo(session, done, "DONE");

  const board = await call(session, "GET", "/projects/LJ/board");
  const columns = (board.json as unknown as {
    columns: Array<{ status: string; count: number; points: number; always: boolean }>;
  }).columns;

  const by = (status: string) => columns.find((column) => column.status === status);
  assert.equal(by("TODO")?.count, 1);
  assert.equal(by("TODO")?.points, 5);
  assert.equal(by("IN_PROGRESS")?.points, 8);
  assert.equal(by("DONE")?.points, 3);

  // BLOCKED and CANCELLED are columns too, but only shown when they hold
  // something — an always-empty column is dead space on every board.
  assert.equal(by("BLOCKED")?.always, false);
  assert.equal(by("CANCELLED")?.always, false);
  assert.equal(by("TODO")?.always, true);
});

test("a blocked card says what blocks it and where it returns to", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const blocker = await makeIssue(session, "선행", 3);
  const blocked = await makeIssue(session, "막힌 것", 5);

  await put(session, blocked, { sprint });
  await call(session, "POST", `/issues/${blocked}/links`, {
    ifMatch: (await call(session, "GET", `/issues/${blocked}`)).etag ?? "",
    body: { kind: "blocked_by", to: (await call(session, "GET", `/issues/${blocker}`)).json.uid },
  });
  await call(session, "POST", `/sprints/${sprint}/start`);
  await moveTo(session, blocked, "BLOCKED");

  const board = await call(session, "GET", "/projects/LJ/board");
  const card = (board.json as unknown as {
    issues: Array<{
      key: string; claimable: boolean; blocked_by: string[]; blocked_from: string | null;
    }>;
  }).issues.find((issue) => issue.key === blocked);

  assert.equal(card?.claimable, false);
  // The reason travels with the card. A mark alone sends the reader hunting
  // through the links panel for something the card already knows.
  assert.deepEqual(card?.blocked_by, [blocker]);
  // §5.2 keeps where it came from, so the card can say where it goes back to.
  assert.equal(card?.blocked_from, "IN_PROGRESS");
});

test("the card badge follows the last change, not the creation", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const key = await makeIssue(session, "배지 대상", 3);
  await put(session, key, { sprint });
  await call(session, "POST", `/sprints/${sprint}/start`);

  const cardOf = async (): Promise<{ last_actor_kind: string; created_by_kind: string }> => {
    const board = await call(session, "GET", "/projects/LJ/board");
    return (board.json as unknown as {
      issues: Array<{ key: string; last_actor_kind: string; created_by_kind: string }>;
    }).issues.find((issue) => issue.key === key)!;
  };

  assert.equal((await cardOf()).last_actor_kind, "human");

  const file = path.join(session.board, "issues", "LJ", `${key}.md`);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace(/^title: .*$/m, "title: 밖에서 고침"),
  );
  await session.server.reconcile();

  const external = await cardOf();
  assert.equal(external.last_actor_kind, "external");
  assert.equal(external.created_by_kind, "human", "created_by_kind never moves (§5.1)");

  // A person editing it again takes the badge back.
  await put(session, key, { points: 5 });
  assert.equal((await cardOf()).last_actor_kind, "human");
});

/**
 * S6-D5. The origin has to survive somebody touching the issue.
 *
 * `last_actor_kind` is what the badge shows, and it turns `human` the moment a
 * person triages — which is the very act D16 leans on, moving an agent's
 * backlog item to TODO. So the card also has to carry where the issue came
 * from, or "AI 산출물이 사람 것처럼 보이지 않는다" stops being true exactly when
 * somebody is looking.
 *
 * The screen has no test harness (S2-D1 keeps it vanilla), so this pins the
 * payload the card is built from. It is the closest thing to the claim that can
 * be checked automatically; the rendering itself was checked in a browser.
 */
test("an agent's issue still says so after a person has touched it", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const key = await makeAgentIssue(session, "에이전트가 적재한 것");
  await put(session, key, { sprint });
  await call(session, "POST", `/sprints/${sprint}/start`);

  const cardOf = async () => {
    const board = await call(session, "GET", "/projects/LJ/board");
    return (board.json as unknown as {
      issues: Array<{ key: string; last_actor_kind: string; created_by_kind: string }>;
    }).issues.find((issue) => issue.key === key)!;
  };

  const fresh = await cardOf();
  assert.equal(fresh.created_by_kind, "agent");

  // The human triage step. Afterwards the actor badge says 사람 — and the card
  // must still be able to say the issue came from an agent.
  await put(session, key, { points: 5 });
  const triaged = await cardOf();
  assert.equal(triaged.last_actor_kind, "human", "the last change was a person's");
  assert.equal(triaged.created_by_kind, "agent", "and the origin did not move with it");

  // Both routes, because the card is built from whichever view is open and the
  // backlog list is where triage actually happens. Checking only the board
  // payload let a first attempt at this test pass while the list route had been
  // stripped of the field.
  const listed = await call(session, "GET", "/issues?limit=50");
  const row = (listed.json as unknown as {
    issues: Array<{ key: string; created_by_kind: string }>;
  }).issues.find((issue) => issue.key === key)!;
  assert.equal(row.created_by_kind, "agent", "the backlog list carries the origin too");
});

test("the board is the same whatever code branch is checked out", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const key = await makeIssue(session, "브랜치 무관", 3);
  await put(session, key, { sprint });
  await call(session, "POST", `/sprints/${sprint}/start`);

  const before = await call(session, "GET", "/projects/LJ/board");

  git(session.repo, ["checkout", "-q", "-b", "feat/somewhere-else"]);
  fs.writeFileSync(path.join(session.repo, "README.md"), "# different\n");
  git(session.repo, ["add", "-A"]);
  git(session.repo, ["-c", "user.email=b@e.com", "-c", "user.name=B", "commit", "-qm", "other"]);

  const after = await call(session, "GET", "/projects/LJ/board");

  // AC26, D1: `.localjira/` is a worktree of the localjira/data branch, so it
  // does not follow the code branch. Two people on different branches see one
  // board, which is the whole point of keeping the data on its own branch.
  assert.deepEqual(after.json.issues, before.json.issues);
  assert.deepEqual(after.json.sprint, before.json.sprint);
});

test("an external status change moves the card without a reload", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const key = await makeIssue(session, "밖에서 옮겨질 것", 3);
  await put(session, key, { sprint });
  await call(session, "POST", `/sprints/${sprint}/start`);
  await moveTo(session, key, "TODO");

  const file = path.join(session.board, "issues", "LJ", `${key}.md`);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace(/^status: TODO$/m, "status: IN_PROGRESS"),
  );
  await session.server.reconcile();

  const board = await call(session, "GET", "/projects/LJ/board");
  const card = (board.json as unknown as {
    issues: Array<{ key: string; status: string }>;
  }).issues.find((issue) => issue.key === key);
  assert.equal(card?.status, "IN_PROGRESS", "the column follows the file");
});

test("a five thousand issue board answers inside the budget", { timeout: 180_000 }, async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session, null);
  await session.server.close();

  const directory = path.join(session.board, "issues", "LJ");
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 1; index <= 5_000; index += 1) {
    fs.writeFileSync(
      path.join(directory, `LJ-${index + 100}.md`),
      `---\nuid: 01JBRD${String(index).padStart(20, "0")}\nkey: LJ-${index + 100}\n` +
        `type: task\ntitle: 대량 ${index}\nstatus: ${index % 2 === 0 ? "TODO" : "IN_PROGRESS"}\n` +
        `sprint: ${sprint}\npoints: 3\nbacklog_rank: "${String(index).padStart(6, "0")}"\n---\n\n`,
    );
  }

  const reopened = await startServer({ cwd: session.repo, port: 0, watch: false });
  t.after(() => reopened.close());
  const login = await fetch(`${reopened.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "owner", password: PASSWORD }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  await fetch(`${reopened.url}/sprints/${sprint}/start`, { method: "POST", headers: { cookie } });

  const timings: number[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const started = performance.now();
    const board = await fetch(`${reopened.url}/projects/LJ/board`, { headers: { cookie } });
    assert.equal(board.status, 200);
    const body = (await board.json()) as { issues: unknown[] };
    assert.ok(body.issues.length > 0);
    timings.push(performance.now() - started);
  }

  timings.sort((a, b) => a - b);
  const p95 = timings[Math.floor(timings.length * 0.95) - 1];
  assert.ok(p95 < 1_000, `p95 was ${p95.toFixed(0)}ms against a 1,000ms budget (N1)`);
  process.stdout.write(`      (5,000 issue board: p95 ${p95.toFixed(0)}ms)\n`);
});
