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
  agent: string;
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-cycle-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "c@example.com"]);
  git(repo, ["config", "user.name", "Cycle"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]);
  cli(repo, ["admin", "create", "--id", "owner", "--name", "오너", "--password", PASSWORD]);
  cli(repo, ["admin", "create", "--id", "bot", "--name", "봇", "--password", PASSWORD, "--role", "agent"]);

  const server = await startServer({ cwd: repo, port: 0, watch: false });
  t.after(() => server.close());

  const signIn = async (id: string): Promise<string> => {
    const login = await fetch(`${server.url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    return (login.headers.get("set-cookie") ?? "").split(";")[0];
  };

  return {
    server,
    owner: await signIn("owner"),
    agent: await signIn("bot"),
    board: path.join(repo, ".localjira"),
  };
}

async function call(
  session: Session,
  method: string,
  route: string,
  options: { body?: unknown; ifMatch?: string; as?: string } = {},
) {
  const response = await fetch(`${session.server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: options.as ?? session.owner,
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
      name: "S",
      start_at: "2026-08-03T09:00:00+09:00",
      end_at: "2026-08-17T18:00:00+09:00",
      ...(capacity === null ? {} : { capacity }),
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.id as unknown as string;
}

async function makeIssue(session: Session, title: string, points?: number): Promise<string> {
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title, ...(points === undefined ? {} : { points }) },
  });
  assert.equal(created.status, 201);
  return created.json.key as unknown as string;
}

async function put(session: Session, key: string, body: Record<string, unknown>) {
  const current = await call(session, "GET", `/issues/${key}`);
  return call(session, "PUT", `/issues/${key}`, { ifMatch: current.etag ?? "", body });
}

async function moveTo(session: Session, key: string, status: string): Promise<void> {
  const route: Record<string, string[]> = {
    DONE: ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"],
    IN_PROGRESS: ["TODO", "IN_PROGRESS"],
    CANCELLED: ["CANCELLED"],
    TODO: ["TODO"],
  };
  for (const to of route[status]) {
    const current = await call(session, "GET", `/issues/${key}`);
    const moved = await call(session, "POST", `/issues/${key}/transitions`, {
      ifMatch: current.etag ?? "",
      body: { to },
    });
    assert.equal(moved.status, 200, `could not move ${key} to ${to}`);
  }
}

test("starting reports the capacity overshoot without refusing", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session, 24);

  for (const points of [13, 8, 9]) {
    const key = await makeIssue(session, `${points}점`, points);
    await put(session, key, { sprint });
  }

  const started = await call(session, "POST", `/sprints/${sprint}/start`);
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.match(String(started.json.warning), /초과/);
  assert.equal((started.json as unknown as { plan: { over: number } }).plan.over, 6);

  const shown = await call(session, "GET", `/sprints/${sprint}`);
  assert.equal((shown.json as unknown as { status: string }).status, "ACTIVE");
});

test("a project has one active sprint, and says which when refusing", async (t) => {
  const session = await makeSession(t);
  const first = await makeSprint(session);
  const second = await makeSprint(session);

  assert.equal((await call(session, "POST", `/sprints/${first}/start`)).status, 200);

  const refused = await call(session, "POST", `/sprints/${second}/start`);
  assert.equal(refused.status, 409);
  assert.equal(
    (refused.json as unknown as { active: string }).active,
    first,
    "named, so the caller can close it rather than guess",
  );

  const untouched = await call(session, "GET", `/sprints/${second}`);
  assert.equal((untouched.json as unknown as { status: string }).status, "PLANNED");
});

test("two simultaneous starts leave exactly one active", async (t) => {
  const session = await makeSession(t);
  const first = await makeSprint(session);
  const second = await makeSprint(session);

  // Both in flight before either resolves. The writer serialises, and the
  // second attempt sees the first one's result rather than the state it read.
  const [a, b] = await Promise.all([
    call(session, "POST", `/sprints/${first}/start`),
    call(session, "POST", `/sprints/${second}/start`),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], `got ${JSON.stringify(statuses)}`);

  const listed = await call(session, "GET", "/projects/LJ/sprints?status=ACTIVE");
  assert.equal((listed.json as unknown as { sprints: unknown[] }).sprints.length, 1);
});

test("a closed sprint cannot be restarted", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  await call(session, "POST", `/sprints/${sprint}/start`);
  await call(session, "POST", `/sprints/${sprint}/close`, { body: { carry_over: { to: null } } });

  // PLANNED → ACTIVE → CLOSED is one way. There is no transition back (§5.2).
  const refused = await call(session, "POST", `/sprints/${sprint}/start`);
  assert.equal(refused.status, 409);
  assert.equal((refused.json as unknown as { status: string }).status, "CLOSED");
});

test("closing without a choice changes nothing and says what it would move", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);

  const done = await makeIssue(session, "끝난 것", 3);
  const working = await makeIssue(session, "하는 중", 5);
  const todo = await makeIssue(session, "안 한 것", 2);
  const dropped = await makeIssue(session, "취소한 것", 8);
  for (const key of [done, working, todo, dropped]) {
    await put(session, key, { sprint });
  }
  await call(session, "POST", `/sprints/${sprint}/start`);
  await moveTo(session, done, "DONE");
  await moveTo(session, working, "IN_PROGRESS");
  await moveTo(session, dropped, "CANCELLED");

  const asked = await call(session, "POST", `/sprints/${sprint}/close`);
  assert.equal(asked.status, 200);
  const body = asked.json as unknown as {
    pending: boolean; unfinished: string[]; cancelled: string[]; strategies: string[];
  };

  assert.equal(body.pending, true);
  assert.deepEqual(body.unfinished.sort(), [working, todo].sort());
  // CANCELLED counts as settled — carrying it would move a decision not to do
  // something into the next sprint — but it is reported apart from the finished
  // work so the two do not read as the same outcome (S1-D5).
  assert.deepEqual(body.cancelled, [dropped]);
  assert.ok(body.strategies.length > 0);

  const stillOpen = await call(session, "GET", `/sprints/${sprint}`);
  assert.equal((stillOpen.json as unknown as { status: string }).status, "ACTIVE");
});

test("carrying into the next sprint moves only the unfinished work", async (t) => {
  const session = await makeSession(t);
  const current = await makeSprint(session);
  const next = await makeSprint(session);

  const done = await makeIssue(session, "끝난 것", 3);
  const working = await makeIssue(session, "하는 중", 5);
  for (const key of [done, working]) {
    await put(session, key, { sprint: current });
  }
  await call(session, "POST", `/sprints/${current}/start`);
  await moveTo(session, done, "DONE");

  const closed = await call(session, "POST", `/sprints/${current}/close`, {
    body: { carry_over: { to: next } },
  });
  assert.equal(closed.status, 200);
  assert.equal((closed.json as unknown as { pending: boolean }).pending, false);

  assert.equal(
    ((await call(session, "GET", `/issues/${working}`)).json as unknown as { sprint: string }).sprint,
    next,
  );
  assert.equal(
    ((await call(session, "GET", `/issues/${done}`)).json as unknown as { sprint: string }).sprint,
    current,
    "finished work stays where it was finished",
  );
  assert.equal(
    ((await call(session, "GET", `/sprints/${current}`)).json as unknown as { status: string }).status,
    "CLOSED",
  );
});

test("carrying to the backlog keeps the backlog position", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const key = await makeIssue(session, "돌아갈 것", 5);

  const before = await call(session, "GET", `/issues/${key}`);
  const rank = (before.json as unknown as { backlog_rank: string }).backlog_rank;

  await put(session, key, { sprint });
  await call(session, "POST", `/sprints/${sprint}/start`);
  await call(session, "POST", `/sprints/${sprint}/close`, { body: { carry_over: { to: null } } });

  const after = await call(session, "GET", `/issues/${key}`);
  assert.equal((after.json as unknown as { sprint?: string }).sprint, undefined);
  // ADR-005 §1: the two ranks are separate so a round trip through a sprint
  // does not shuffle the backlog.
  assert.equal((after.json as unknown as { backlog_rank: string }).backlog_rank, rank);
});

test("an impossible carry-over target aborts the whole close", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const finished = await makeSprint(session);
  const key = await makeIssue(session, "이월될 것", 3);

  await put(session, key, { sprint });
  await call(session, "POST", `/sprints/${sprint}/start`);

  const file = path.join(session.board, "sprints", "LJ", `${finished}.yaml`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^status: .*$/m, "status: CLOSED"));
  await session.server.reconcile();

  for (const target of [finished, "LJ-S99", sprint]) {
    const refused = await call(session, "POST", `/sprints/${sprint}/close`, {
      body: { carry_over: { to: target } },
    });
    assert.equal(refused.status, 400, `${target} should be refused: ${JSON.stringify(refused.json)}`);
  }

  // Nothing may have moved and the sprint must still be open.
  assert.equal(
    ((await call(session, "GET", `/issues/${key}`)).json as unknown as { sprint: string }).sprint,
    sprint,
  );
  assert.equal(
    ((await call(session, "GET", `/sprints/${sprint}`)).json as unknown as { status: string }).status,
    "ACTIVE",
  );
});

test("a planned sprint cannot be closed", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);

  const refused = await call(session, "POST", `/sprints/${sprint}/close`, {
    body: { carry_over: { to: null } },
  });
  assert.equal(refused.status, 409);
  assert.equal((refused.json as unknown as { status: string }).status, "PLANNED");
});

test("two active sprints block the commands until a person fixes one", async (t) => {
  const session = await makeSession(t);
  const first = await makeSprint(session);
  const second = await makeSprint(session);
  await call(session, "POST", `/sprints/${first}/start`);

  // What a merge of two clones that each started a sprint leaves behind.
  const file = path.join(session.board, "sprints", "LJ", `${second}.yaml`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^status: .*$/m, "status: ACTIVE"));
  await session.server.reconcile();

  // This is r11a's carried criterion: it detected the conflict but had no
  // command to block. Acting now would pick one of the two on the team's
  // behalf, which is exactly what nobody has decided.
  for (const route of [`/sprints/${first}/close`, `/sprints/${second}/start`]) {
    const blocked = await call(session, "POST", route, { body: { carry_over: { to: null } } });
    assert.equal(blocked.status, 409, `${route}: ${JSON.stringify(blocked.json)}`);
    const body = blocked.json as unknown as { error: { code: string }; paths: string[] };
    assert.equal(body.error.code, "E_SPRINT_CONFLICT");
    assert.equal(body.paths.length, 2, "both files are named so one can be fixed");
  }

  // Repairing one file lifts the block.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^status: .*$/m, "status: PLANNED"));
  await session.server.reconcile();

  const closed = await call(session, "POST", `/sprints/${first}/close`, {
    body: { carry_over: { to: null } },
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));
});

test("a passing date moves nothing on its own", async (t) => {
  const session = await makeSession(t);
  const created = await call(session, "POST", "/projects/LJ/sprints", {
    body: {
      name: "이미 끝났어야 할 것",
      start_at: "2020-01-01T09:00:00+09:00",
      end_at: "2020-01-14T18:00:00+09:00",
    },
  });
  const sprint = created.json.id as unknown as string;
  const key = await makeIssue(session, "안 끝난 일", 5);
  await put(session, key, { sprint });
  await call(session, "POST", `/sprints/${sprint}/start`);

  await session.server.reconcile();

  // §5.2: a clock does not decide that the work stopped.
  assert.equal(
    ((await call(session, "GET", `/sprints/${sprint}`)).json as unknown as { status: string }).status,
    "ACTIVE",
  );
  assert.equal(
    ((await call(session, "GET", `/issues/${key}`)).json as unknown as { sprint: string }).sprint,
    sprint,
    "and nothing was carried anywhere",
  );
});

test("an agent cannot start or close a sprint", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);

  // S2-D3 gave sprints their own capability precisely so this stays true.
  const refused = await call(session, "POST", `/sprints/${sprint}/start`, { as: session.agent });
  assert.equal(refused.status, 403);
});

test("start and close are recorded with the carried count", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  const key = await makeIssue(session, "이월될 것", 3);
  await put(session, key, { sprint });
  await call(session, "POST", `/sprints/${sprint}/start`);
  await call(session, "POST", `/sprints/${sprint}/close`, { body: { carry_over: { to: null } } });

  const events = fs
    .readdirSync(path.join(session.board, "events"))
    .flatMap((day) =>
      fs
        .readdirSync(path.join(session.board, "events", day))
        .flatMap((file) =>
          fs
            .readFileSync(path.join(session.board, "events", day, file), "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line) as {
              verb: string; actor_id: string; actor_kind: string; detail?: { carried?: number };
            }),
        ),
    );

  const started = events.find((event) => event.verb === "sprint.started");
  const closed = events.find((event) => event.verb === "sprint.closed");
  assert.ok(started, "the start is in the audit trail");
  assert.ok(closed, "so is the close");
  assert.equal(closed.actor_id, "owner");
  assert.equal(closed.actor_kind, "human");
  assert.equal(closed.detail?.carried, 1, "with how much moved");
});
