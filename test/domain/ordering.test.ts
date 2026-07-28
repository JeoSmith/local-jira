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
  agent: string;
  repo: string;
  board: string;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout;
}

async function makeSession(t: { after: (fn: () => void) => void }): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-order-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "o@example.com"]);
  git(repo, ["config", "user.name", "Order"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo });
  cli(["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]);
  cli(["admin", "create", "--id", "owner", "--name", "오너", "--password", PASSWORD]);
  cli(["admin", "create", "--id", "bot", "--name", "봇", "--password", PASSWORD, "--role", "agent"]);

  const server = await startServer({ cwd: repo, port: 0, watch: false });
  t.after(() => server.close());

  const signIn = async (id: string): Promise<string> => {
    const login = await fetch(`${server.url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, password: PASSWORD }),
    });
    assert.equal(login.status, 200, `${id} could not sign in`);
    return (login.headers.get("set-cookie") ?? "").split(";")[0];
  };

  return {
    server,
    cookie: await signIn("owner"),
    agent: await signIn("bot"),
    repo,
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
      cookie: options.as ?? session.cookie,
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

interface Made {
  key: string;
  uid: string;
}

async function make(session: Session, title: string): Promise<Made> {
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title },
  });
  assert.equal(created.status, 201);
  return { key: created.json.key as unknown as string, uid: created.json.uid as unknown as string };
}

async function order(session: Session): Promise<string[]> {
  const listed = await call(session, "GET", "/issues?limit=500");
  return (listed.json as unknown as { issues: Array<{ key: string }> }).issues.map(
    (issue) => issue.key,
  );
}

function changedFiles(session: Session): string[] {
  return git(session.board, ["status", "--porcelain"])
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((line) => line.startsWith("issues/"));
}

function commitAll(session: Session): void {
  git(session.board, ["add", "-A"]);
  git(session.board, ["-c", "user.email=o@e.com", "-c", "user.name=O", "commit", "-qm", "state"]);
}

test("a move rewrites exactly one file, wherever it lands", async (t) => {
  const session = await makeSession(t);
  const made = [];
  for (const title of ["첫째", "둘째", "셋째", "넷째", "다섯째"]) {
    made.push(await make(session, title));
  }
  assert.deepEqual(await order(session), made.map((issue) => issue.key));

  // …into the middle
  commitAll(session);
  let moved = await call(session, "POST", `/issues/${made[4].key}/rank`, {
    body: { field: "backlog_rank", after: made[1].uid, before: made[2].uid },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.deepEqual(changedFiles(session), [`issues/LJ/${made[4].key}.md`], "one file (AC4)");
  assert.deepEqual(await order(session), [
    made[0].key, made[1].key, made[4].key, made[2].key, made[3].key,
  ]);

  // …to the top
  commitAll(session);
  moved = await call(session, "POST", `/issues/${made[3].key}/rank`, {
    body: { field: "backlog_rank", after: null, before: made[0].uid },
  });
  assert.equal(moved.status, 200);
  assert.deepEqual(changedFiles(session), [`issues/LJ/${made[3].key}.md`]);
  assert.equal((await order(session))[0], made[3].key);

  // …and to the bottom
  commitAll(session);
  const current = await order(session);
  const last = current[current.length - 1];
  moved = await call(session, "POST", `/issues/${made[0].key}/rank`, {
    body: {
      field: "backlog_rank",
      after: made.find((issue) => issue.key === last)!.uid,
      before: null,
    },
  });
  assert.equal(moved.status, 200);
  assert.deepEqual(changedFiles(session), [`issues/LJ/${made[0].key}.md`]);
  assert.equal((await order(session)).at(-1), made[0].key);
});

test("moving to where it already is changes nothing at all", async (t) => {
  const session = await makeSession(t);
  const first = await make(session, "첫째");
  const second = await make(session, "둘째");
  const third = await make(session, "셋째");
  commitAll(session);

  const noop = await call(session, "POST", `/issues/${second.key}/rank`, {
    body: { field: "backlog_rank", after: first.uid, before: third.uid },
  });
  assert.equal(noop.status, 200);
  assert.equal(noop.json.changed as unknown as boolean, false);
  assert.deepEqual(changedFiles(session), [], "no file, no event, nothing in git status");
});

test("stale neighbours are refused with the order as it now stands", async (t) => {
  const session = await makeSession(t);
  const a = await make(session, "A");
  const b = await make(session, "B");
  const c = await make(session, "C");
  const d = await make(session, "D");

  // A client reads [A, B, C, D] and decides to put D between A and B. Before it
  // sends that, somebody else drops C into exactly that gap.
  const interposed = await call(session, "POST", `/issues/${c.key}/rank`, {
    body: { field: "backlog_rank", after: a.uid, before: b.uid },
  });
  assert.equal(interposed.status, 200);
  assert.deepEqual(await order(session), [a.key, c.key, b.key, d.key]);

  // A and B are no longer next to each other, so the move no longer describes
  // any position in this list. Guessing one would drop the card somewhere the
  // person never pointed at.
  const stale = await call(session, "POST", `/issues/${d.key}/rank`, {
    body: { field: "backlog_rank", after: a.uid, before: b.uid },
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.json));
  assert.equal(
    (stale.json as unknown as { error: { code: string } }).error.code,
    "E_NEIGHBOURS_MOVED",
  );
  assert.deepEqual(
    (stale.json as unknown as { order: string[] }).order,
    [a.key, c.key, b.key],
    "the order as it now stands, so the client can redraw and retry",
  );
  assert.deepEqual(await order(session), [a.key, c.key, b.key, d.key], "nothing moved");
});

test("an exhausted gap rebalances and says which issues it rewrote", async (t) => {
  const session = await makeSession(t);
  const top = await make(session, "위");
  const bottom = await make(session, "아래");
  const filler = [];
  for (let index = 0; index < 8; index += 1) {
    filler.push(await make(session, `채움 ${index}`));
  }

  // Drive the same gap until the string space gives out. Each move puts the
  // card immediately after `top`, halving what is left every time.
  let rebalanced: string[] = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = await order(session);
    const target = current.at(-1)!;
    const targetUid = [top, bottom, ...filler].find((issue) => issue.key === target)!.uid;
    const after = current[0];
    const afterUid = [top, bottom, ...filler].find((issue) => issue.key === after)!.uid;
    const beforeKey = current[1];
    const beforeUid = [top, bottom, ...filler].find((issue) => issue.key === beforeKey)!.uid;

    const moved = await call(session, "POST", `/issues/${target}/rank`, {
      body: { field: "backlog_rank", after: afterUid, before: beforeUid },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    void targetUid;

    const touched = moved.json.rebalanced as unknown as string[];
    if (touched.length > 0) {
      rebalanced = touched;
      break;
    }
  }

  assert.ok(rebalanced.length > 0, "the gap never ran out, so nothing was proved");
  // AC: the fact is reported, with the issues it covered.
  assert.ok(rebalanced.every((key) => key.startsWith("LJ-")));

  // And the list is still in one piece.
  const finalOrder = await order(session);
  assert.equal(new Set(finalOrder).size, finalOrder.length, "no issue was lost or duplicated");
  assert.equal(finalOrder.length, 10);
});

test("the two orderings are independent", async (t) => {
  const session = await makeSession(t);
  const issue = await make(session, "이슈");
  const other = await make(session, "다른 이슈");

  await call(session, "POST", `/issues/${issue.key}/rank`, {
    body: { field: "backlog_rank", after: other.uid, before: null },
  });
  const backlog = await call(session, "GET", `/issues/${issue.key}`);
  const rank = (backlog.json as unknown as { backlog_rank: string }).backlog_rank;

  // A board move must leave the backlog position alone: an issue that drops out
  // of a sprint has to come back to where it was in the backlog (ADR-005 §1).
  const onBoard = await call(session, "POST", `/issues/${issue.key}/rank`, {
    body: { field: "board_rank", after: other.uid, before: null },
  });
  assert.equal(onBoard.status, 200, JSON.stringify(onBoard.json));

  const after = await call(session, "GET", `/issues/${issue.key}`);
  assert.equal((after.json as unknown as { backlog_rank: string }).backlog_rank, rank);
  assert.ok((after.json as unknown as { board_rank?: string }).board_rank, "board_rank was set");
});

test("an agent without the rank capability is refused", async (t) => {
  const session = await makeSession(t);
  const first = await make(session, "첫째");
  const second = await make(session, "둘째");

  const refused = await call(session, "POST", `/issues/${second.key}/rank`, {
    as: session.agent,
    body: { field: "backlog_rank", after: null, before: first.uid },
  });
  // D9: reordering the backlog is deciding what the team does next, which is
  // not something a token gets by being able to edit issues.
  assert.equal(refused.status, 403);
});

test("duplicate ranks from a merge sort deterministically rather than erroring", async (t) => {
  const session = await makeSession(t);
  const first = await make(session, "A");
  const second = await make(session, "B");
  await session.server.close();

  // What a merge of two clones that each inserted into the same gap leaves.
  for (const key of [first.key, second.key]) {
    const file = path.join(session.board, "issues", "LJ", `${key}.md`);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace(/^backlog_rank: .*$/m, 'backlog_rank: "hzzzzz"'),
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

  const listed = await fetch(`${reopened.url}/issues`, { headers: { cookie } });
  assert.equal(listed.status, 200, "a duplicate rank is not an error (ADR-005 §1)");

  const keys = ((await listed.json()) as { issues: Array<{ key: string; uid: string }> }).issues;
  const byUid = [...keys].sort((a, b) => a.uid.localeCompare(b.uid)).map((issue) => issue.key);
  assert.deepEqual(
    keys.map((issue) => issue.key),
    byUid,
    "equal ranks fall back to uid, so every clone sees the same order",
  );
});

test("a stale If-Match on a move is a 412 like any other write", async (t) => {
  const session = await makeSession(t);
  const first = await make(session, "첫째");
  const second = await make(session, "둘째");

  const read = await call(session, "GET", `/issues/${second.key}`);
  const held = read.etag ?? "";

  // Somebody else changes the issue, so the snapshot the caller holds is old.
  await call(session, "PUT", `/issues/${second.key}`, {
    ifMatch: held,
    body: { title: "남이 먼저 고침" },
  });

  const stale = await call(session, "POST", `/issues/${second.key}/rank`, {
    ifMatch: held,
    body: { field: "backlog_rank", after: null, before: first.uid },
  });
  assert.equal(stale.status, 412, JSON.stringify(stale.json));

  // Without a precondition the same move is fine: the neighbours are what pin
  // the position, and they have not moved.
  const fine = await call(session, "POST", `/issues/${second.key}/rank`, {
    body: { field: "backlog_rank", after: null, before: first.uid },
  });
  assert.equal(fine.status, 200);
  assert.deepEqual(await order(session), [second.key, first.key]);
});

test("a five thousand issue backlog sorts well inside the budget", { timeout: 180_000 }, async (t) => {
  const session = await makeSession(t);
  await session.server.close();

  // Written straight to disk: five thousand API calls would measure the write
  // path, and the budget in question is the read.
  const directory = path.join(session.board, "issues", "LJ");
  fs.mkdirSync(directory, { recursive: true });
  const ranks: string[] = [];
  for (let index = 1; index <= 5_000; index += 1) {
    const rank = `${String(index).padStart(6, "0")}`;
    ranks.push(rank);
    fs.writeFileSync(
      path.join(directory, `LJ-${index + 100}.md`),
      `---\nuid: 01JBIG${String(index).padStart(20, "0")}\nkey: LJ-${index + 100}\n` +
        `type: task\ntitle: 대량 ${index}\nstatus: BACKLOG\nbacklog_rank: "${rank}"\n---\n\n`,
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

  // p95 over twenty reads of the first page, which is what a backlog screen
  // actually asks for (N1).
  const timings: number[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const started = performance.now();
    const listed = await fetch(`${reopened.url}/issues?limit=100`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { issues: Array<{ key: string }> };
    assert.equal(body.issues.length, 100);
    timings.push(performance.now() - started);
  }

  timings.sort((a, b) => a - b);
  const p95 = timings[Math.floor(timings.length * 0.95) - 1];
  assert.ok(p95 < 1_000, `p95 was ${p95.toFixed(0)}ms against a 1,000ms budget (N1)`);
  process.stdout.write(`      (5,000 issues: p95 ${p95.toFixed(0)}ms)\n`);
});
