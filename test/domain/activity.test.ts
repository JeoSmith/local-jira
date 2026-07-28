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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-activity-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "a@example.com"]);
  git(repo, ["config", "user.name", "Activity"]);
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

interface Entry {
  eventId: string;
  at: string;
  verb: string;
  actor: { id: string | null; kind: string | null; initiatedBy: string | null; runId: string | null };
  before: unknown;
  after: unknown;
  sourceCommit: string | null;
}

async function timeline(session: Session, key: string, query = ""): Promise<Entry[]> {
  const listed = await call(session, "GET", `/issues/${key}/activity${query}`);
  assert.equal(listed.status, 200);
  return (listed.json as unknown as { entries: Entry[] }).entries;
}

test("a timeline shows what happened, newest first, with the actor", async (t) => {
  const session = await makeSession(t);
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title: "추적할 이슈", points: 3 },
  });
  const key = created.json.key as unknown as string;

  await call(session, "PUT", `/issues/${key}`, {
    ifMatch: created.etag ?? "",
    body: { points: 8 },
  });
  const current = await call(session, "GET", `/issues/${key}`);
  await call(session, "POST", `/issues/${key}/transitions`, {
    ifMatch: current.etag ?? "",
    body: { to: "TODO" },
  });

  const entries = await timeline(session, key);
  assert.deepEqual(
    entries.map((entry) => entry.verb),
    ["issue.transitioned", "issue.updated", "issue.created"],
    "newest first",
  );

  for (const entry of entries) {
    assert.equal(entry.actor.kind, "human");
    assert.equal(entry.actor.id, "owner");
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
  }

  // The field change carries both sides, so the entry says what became what.
  const updated = entries.find((entry) => entry.verb === "issue.updated");
  assert.deepEqual(updated?.before, { points: 3 });
  assert.deepEqual(updated?.after, { points: 8 });
});

test("reading the timeline does not make the timeline longer", async (t) => {
  const session = await makeSession(t);
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title: "조회만" },
  });
  const key = created.json.key as unknown as string;

  const before = await timeline(session, key);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await timeline(session, key);
    await call(session, "GET", "/issues");
    await call(session, "GET", `/issues/${key}`);
  }
  const after = await timeline(session, key);

  // N7 puts reads outside the audit scope, and a record that grows when you
  // look at it is not a record of what happened.
  assert.deepEqual(
    after.map((entry) => entry.eventId),
    before.map((entry) => entry.eventId),
  );
});

test("an external edit is attributed to nobody in particular", async (t) => {
  const session = await makeSession(t);
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title: "외부에서 고칠 것" },
  });
  const key = created.json.key as unknown as string;

  const file = path.join(session.board, "issues", "LJ", `${key}.md`);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace(/^title: .*$/m, "title: 에디터로 고침"),
  );
  await session.server.reconcile();

  const [newest] = await timeline(session, key);
  assert.equal(newest.verb, "issue.changed_externally");
  assert.equal(newest.actor.kind, "external");
  assert.equal(newest.actor.id, "unknown", "no authenticated actor to name");
  assert.equal(newest.sourceCommit, null, "a git author would be a guess, not a fact");
});

test("the timeline survives losing the index", async (t) => {
  const session = await makeSession(t);
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title: "재빌드 대상", points: 2 },
  });
  const key = created.json.key as unknown as string;
  await call(session, "PUT", `/issues/${key}`, {
    ifMatch: created.etag ?? "",
    body: { points: 5 },
  });

  const before = await timeline(session, key);
  assert.equal(before.length, 2);
  await session.server.close();

  fs.rmSync(path.join(session.board, ".local", "index.sqlite"));

  const reopened = await startServer({ cwd: session.repo, port: 0, watch: false });
  t.after(() => reopened.close());
  const login = await fetch(`${reopened.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "owner", password: PASSWORD }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const listed = await fetch(`${reopened.url}/issues/${key}/activity`, { headers: { cookie } });
  const after = ((await listed.json()) as { entries: Entry[] }).entries;

  // AC2: events are file SoT, so the index is a cache and losing it costs
  // nothing — same entries, same order.
  assert.deepEqual(
    after.map((entry) => ({ id: entry.eventId, verb: entry.verb, at: entry.at })),
    before.map((entry) => ({ id: entry.eventId, verb: entry.verb, at: entry.at })),
  );
});

test("a long timeline pages without repeating or skipping an entry", async (t) => {
  const session = await makeSession(t);
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title: "긴 이력", points: 0 },
  });
  const key = created.json.key as unknown as string;

  for (let points = 1; points <= 12; points += 1) {
    const current = await call(session, "GET", `/issues/${key}`);
    const updated = await call(session, "PUT", `/issues/${key}`, {
      ifMatch: current.etag ?? "",
      body: { points },
    });
    assert.equal(updated.status, 200);
  }

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const query: string = `?limit=5${cursor === null ? "" : `&before=${cursor}`}`;
    const response = await call(session, "GET", `/issues/${key}/activity${query}`);
    const body = response.json as unknown as {
      entries: Entry[];
      hasMore: boolean;
      nextBefore: string | null;
    };
    seen.push(...body.entries.map((entry) => entry.eventId));
    if (!body.hasMore) {
      break;
    }
    cursor = body.nextBefore;
  }

  assert.equal(seen.length, 13, "creation plus twelve updates");
  assert.equal(new Set(seen).size, seen.length, "no entry appeared on two pages");
  assert.deepEqual([...seen].sort().reverse(), seen, "paging kept the order");
});

test("a card reports who touched it last, not who created it", async (t) => {
  const session = await makeSession(t);
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title: "배지 대상" },
  });
  const key = created.json.key as unknown as string;

  const listed = await call(session, "GET", "/issues");
  const before = (listed.json as unknown as {
    issues: Array<{ key: string; last_actor_kind: string; created_by_kind: string }>;
  }).issues.find((issue) => issue.key === key);
  assert.equal(before?.last_actor_kind, "human");

  // An edit made outside the API must change the badge, or an agent's or an
  // editor's change is indistinguishable from the human creation beneath it.
  const file = path.join(session.board, "issues", "LJ", `${key}.md`);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace(/^title: .*$/m, "title: 밖에서 고침"),
  );
  await session.server.reconcile();

  const again = await call(session, "GET", "/issues");
  const after = (again.json as unknown as {
    issues: Array<{ key: string; last_actor_kind: string; created_by_kind: string }>;
  }).issues.find((issue) => issue.key === key);

  assert.equal(after?.last_actor_kind, "external");
  assert.equal(after?.created_by_kind, "human", "created_by_kind is immutable (§5.1)");
});

test("the timeline of an unknown issue is a 404, not an empty list", async (t) => {
  const session = await makeSession(t);
  const missing = await call(session, "GET", "/issues/LJ-9999/activity");
  assert.equal(missing.status, 404);
});
