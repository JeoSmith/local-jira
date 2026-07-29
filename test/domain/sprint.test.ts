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
  repo: string;
  board: string;
  restart(): Promise<void>;
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-sprint-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "p@example.com"]);
  git(repo, ["config", "user.name", "Sprint"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "Asia/Seoul"]);
  cli(repo, ["admin", "create", "--id", "owner", "--name", "오너", "--password", PASSWORD]);
  cli(repo, ["admin", "create", "--id", "bot", "--name", "봇", "--password", PASSWORD, "--role", "agent"]);

  const session = { repo, board: path.join(repo, ".localjira") } as Session;
  const boot = async (): Promise<void> => {
    session.server = await startServer({ cwd: repo, port: 0, watch: false });
    const signIn = async (id: string): Promise<string> => {
      const login = await fetch(`${session.server.url}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, password: PASSWORD }),
      });
      assert.equal(login.status, 200, `${id} could not sign in`);
      return (login.headers.get("set-cookie") ?? "").split(";")[0];
    };
    session.owner = await signIn("owner");
    session.agent = await signIn("bot");
  };
  session.restart = async () => {
    await session.server.close();
    await boot();
  };

  await boot();
  t.after(() => session.server.close());
  return session;
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

const START = "2026-08-03T09:00:00+09:00";
const END = "2026-08-17T18:00:00+09:00";

async function makeSprint(
  session: Session,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; etag: string }> {
  const created = await call(session, "POST", "/projects/LJ/sprints", {
    body: { name: "S3", goal: "보드 MVP", start_at: START, end_at: END, capacity: 24, ...extra },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return { id: created.json.id as unknown as string, etag: created.etag ?? "" };
}

test("a sprint is one file, planned, with the fields the schema names", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);

  assert.equal(sprint.id, "LJ-S1");
  const file = path.join(session.board, "sprints", "LJ", "LJ-S1.yaml");
  assert.equal(fs.existsSync(file), true);

  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^id: LJ-S1$/m);
  assert.match(text, /^status: PLANNED$/m);
  assert.match(text, /^capacity: 24$/m);
  assert.match(text, /^schema_version: 1$/m);

  // Stored exactly as given: the offset is part of the meaning, and reformatting
  // it here would decide a day boundary on the reader's behalf (§5.2).
  assert.match(text, /^start_at: "2026-08-03T09:00:00\+09:00"$/m);
});

test("a timestamp without an offset is refused", async (t) => {
  const session = await makeSession(t);

  for (const value of ["2026-08-03", "2026-08-03T09:00:00", "next monday"]) {
    const refused = await call(session, "POST", "/projects/LJ/sprints", {
      body: { name: "S", start_at: value, end_at: END },
    });
    assert.equal(refused.status, 400, `${value} should be refused`);
    assert.equal(
      (refused.json as unknown as { error: { code: string } }).error.code,
      "E_INVALID_INSTANT",
    );
  }

  assert.equal(fs.existsSync(path.join(session.board, "sprints", "LJ")), false);
});

test("a sprint that ends before it starts is refused", async (t) => {
  const session = await makeSession(t);

  const refused = await call(session, "POST", "/projects/LJ/sprints", {
    body: { name: "거꾸로", start_at: END, end_at: START },
  });
  assert.equal(refused.status, 400);
  assert.match(
    (refused.json as unknown as { error: { message: string } }).error.message,
    /after start_at/,
  );

  // Same instant written two ways still compares as instants, not as text.
  const equal = await call(session, "POST", "/projects/LJ/sprints", {
    body: { name: "같은 순간", start_at: "2026-08-03T09:00:00+09:00", end_at: "2026-08-03T00:00:00Z" },
  });
  assert.equal(equal.status, 400, "09:00+09:00 and 00:00Z are the same moment");
});

test("overlapping planned sprints are allowed", async (t) => {
  const session = await makeSession(t);
  await makeSprint(session);

  // Planning S4 while S3 runs is ordinary. The constraint that matters is one
  // ACTIVE at a time (§5.2), and that belongs to the start command.
  const overlapping = await call(session, "POST", "/projects/LJ/sprints", {
    body: { name: "S4", start_at: "2026-08-10T09:00:00+09:00", end_at: "2026-08-24T18:00:00+09:00" },
  });
  assert.equal(overlapping.status, 201);
});

test("status cannot be set through a field update", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);

  for (const body of [{ status: "ACTIVE" }, { status: "CLOSED" }]) {
    const refused = await call(session, "PATCH", `/sprints/${sprint.id}`, {
      ifMatch: sprint.etag,
      body,
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.json));
    assert.equal(
      (refused.json as unknown as { error: { code: string } }).error.code,
      "E_STATUS_NOT_ALLOWED",
    );
  }

  const unchanged = await call(session, "GET", `/sprints/${sprint.id}`);
  assert.equal((unchanged.json as unknown as { status: string }).status, "PLANNED");
});

test("editing follows the same concurrency rules as an issue", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);

  const missing = await call(session, "PATCH", `/sprints/${sprint.id}`, {
    body: { capacity: 30 },
  });
  assert.equal(missing.status, 428);

  const updated = await call(session, "PATCH", `/sprints/${sprint.id}`, {
    ifMatch: sprint.etag,
    body: { capacity: 30, goal: "보드 MVP + 검색" },
  });
  assert.equal(updated.status, 200);
  assert.equal((updated.json as unknown as { capacity: number }).capacity, 30);

  const stale = await call(session, "PATCH", `/sprints/${sprint.id}`, {
    ifMatch: sprint.etag,
    body: { capacity: 40 },
  });
  assert.equal(stale.status, 412);
});

test("the list filters by status and a missing sprint is a 404", async (t) => {
  const session = await makeSession(t);
  await makeSprint(session);
  await call(session, "POST", "/projects/LJ/sprints", {
    body: { name: "S4", start_at: "2026-09-01T09:00:00+09:00", end_at: "2026-09-14T18:00:00+09:00" },
  });

  const all = await call(session, "GET", "/projects/LJ/sprints");
  assert.equal((all.json as unknown as { sprints: unknown[] }).sprints.length, 2);

  const planned = await call(session, "GET", "/projects/LJ/sprints?status=PLANNED");
  assert.equal((planned.json as unknown as { sprints: unknown[] }).sprints.length, 2);

  const active = await call(session, "GET", "/projects/LJ/sprints?status=ACTIVE");
  assert.equal((active.json as unknown as { sprints: unknown[] }).sprints.length, 0);

  assert.equal((await call(session, "GET", "/sprints/LJ-S99")).status, 404);
});

test("a date passing does not move a sprint by itself", async (t) => {
  const session = await makeSession(t);
  await call(session, "POST", "/projects/LJ/sprints", {
    body: {
      name: "이미 지난 것",
      start_at: "2020-01-01T09:00:00+09:00",
      end_at: "2020-01-14T18:00:00+09:00",
    },
  });

  await session.restart();

  // §5.2: sprints move on explicit commands. A clock that closes a sprint
  // decides on the team's behalf that the work stopped.
  const listed = await call(session, "GET", "/projects/LJ/sprints");
  const sprints = (listed.json as unknown as { sprints: Array<{ status: string }> }).sprints;
  assert.deepEqual(sprints.map((sprint) => sprint.status), ["PLANNED"]);
});

test("deleting a sprint that holds issues is refused until the caller chooses", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);

  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title: "담긴 이슈" },
  });
  const key = created.json.key as unknown as string;
  const file = path.join(session.board, "issues", "LJ", `${key}.md`);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace(/^status: /m, `sprint: ${sprint.id}\nstatus: `),
  );
  await session.server.reconcile();

  const current = await call(session, "GET", `/sprints/${sprint.id}`);
  const refused = await call(session, "DELETE", `/sprints/${sprint.id}`, {
    ifMatch: current.etag ?? "",
  });

  // Deleting it regardless would leave that issue pointing at a sprint that no
  // longer exists — which is exactly what r11a quarantines. The board would
  // break itself on request.
  assert.equal(refused.status, 409, JSON.stringify(refused.json));
  assert.deepEqual((refused.json as unknown as { issues: string[] }).issues, [key]);
  assert.deepEqual((refused.json as unknown as { strategies: string[] }).strategies, ["release"]);

  const released = await call(session, "DELETE", `/sprints/${sprint.id}?strategy=release`, {
    ifMatch: current.etag ?? "",
  });
  assert.equal(released.status, 204);

  const orphan = await call(session, "GET", `/issues/${key}`);
  assert.equal(orphan.status, 200, "the issue survives");
  assert.equal((orphan.json as unknown as { sprint?: string }).sprint, undefined);
  assert.ok(
    (orphan.json as unknown as { backlog_rank: string }).backlog_rank,
    "and keeps its backlog position (ADR-005 §1)",
  );

  // Nothing dangling was left behind for the integrity pass to find.
  const integrity = await call(session, "GET", "/integrity/issues");
  assert.deepEqual((integrity.json as unknown as { quarantined: unknown[] }).quarantined, []);
});

test("an agent cannot shape the sprints", async (t) => {
  const session = await makeSession(t);

  // Its own capability, not issue:write: planning what the team commits to is
  // not a thing a token gets by being able to edit issues.
  const refused = await call(session, "POST", "/projects/LJ/sprints", {
    as: session.agent,
    body: { name: "봇이 만든 것", start_at: START, end_at: END },
  });
  assert.equal(refused.status, 403);
});

test("a broken sprint file is quarantined and the rest still list", async (t) => {
  const session = await makeSession(t);
  await makeSprint(session);
  await call(session, "POST", "/projects/LJ/sprints", {
    body: { name: "S4", start_at: "2026-09-01T09:00:00+09:00", end_at: "2026-09-14T18:00:00+09:00" },
  });

  fs.writeFileSync(path.join(session.board, "sprints", "LJ", "LJ-S2.yaml"), "id: [unclosed\n");
  await session.server.reconcile();

  const listed = await call(session, "GET", "/projects/LJ/sprints");
  const sprints = (listed.json as unknown as { sprints: Array<{ id: string }> }).sprints;
  assert.deepEqual(sprints.map((sprint) => sprint.id), ["LJ-S1"]);

  const integrity = await call(session, "GET", "/integrity/issues");
  assert.equal(
    (integrity.json as unknown as { quarantined: Array<{ path: string }> }).quarantined.some(
      (entry) => entry.path.endsWith("LJ-S2.yaml"),
    ),
    true,
  );
});

test("creating and editing a sprint is recorded", async (t) => {
  const session = await makeSession(t);
  const sprint = await makeSprint(session);
  await call(session, "PATCH", `/sprints/${sprint.id}`, {
    ifMatch: sprint.etag,
    body: { capacity: 30 },
  });

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
            .map((line) => JSON.parse(line) as { verb: string; actor_id: string; actor_kind: string }),
        ),
    );

  const created = events.find((event) => event.verb === "sprint.created");
  const updated = events.find((event) => event.verb === "sprint.updated");
  assert.ok(created, "creation is in the audit trail");
  assert.ok(updated, "so is the edit");
  assert.equal(created.actor_id, "owner");
  assert.equal(created.actor_kind, "human");
});
