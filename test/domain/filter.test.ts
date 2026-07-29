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
  restart(): Promise<void>;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
}

async function makeSession(t: { after: (fn: () => void) => void }): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-filter-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "f@example.com"]);
  git(repo, ["config", "user.name", "Filter"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo });
  cli(["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]);
  cli(["admin", "create", "--id", "owner", "--name", "오너", "--password", PASSWORD]);

  const session = { repo, board: path.join(repo, ".localjira") } as Session;
  const boot = async (): Promise<void> => {
    session.server = await startServer({ cwd: repo, port: 0, watch: false });
    const login = await fetch(`${session.server.url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "owner", password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    session.cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
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

async function make(
  session: Session,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<{ key: string; uid: string }> {
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title, ...extra },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return { key: created.json.key as unknown as string, uid: created.json.uid as unknown as string };
}

async function moveTo(session: Session, key: string, status: string): Promise<void> {
  const path: Record<string, string[]> = {
    TODO: ["TODO"],
    IN_PROGRESS: ["TODO", "IN_PROGRESS"],
    DONE: ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"],
  };
  for (const to of path[status] ?? [status]) {
    const current = await call(session, "GET", `/issues/${key}`);
    const moved = await call(session, "POST", `/issues/${key}/transitions`, {
      ifMatch: current.etag ?? "",
      body: { to },
    });
    assert.equal(moved.status, 200, `could not move ${key} to ${to}`);
  }
}

async function keysOf(session: Session, query: string): Promise<string[]> {
  const listed = await call(session, "GET", `/issues${query}`);
  assert.equal(listed.status, 200, JSON.stringify(listed.json));
  return (listed.json as unknown as { issues: Array<{ key: string }> }).issues.map((i) => i.key);
}

test("different filters all have to hold, repeated values are alternatives", async (t) => {
  const session = await makeSession(t);
  const web = await make(session, "웹 작업", { labels: ["web"], assignee: "owner" });
  const perf = await make(session, "성능 작업", { labels: ["perf"], assignee: "owner" });
  const other = await make(session, "남의 작업", { labels: ["web"], assignee: "someone" });
  await moveTo(session, web.key, "TODO");
  await moveTo(session, other.key, "TODO");

  // One rule everywhere: alternatives inside a parameter, all-of across them.
  assert.deepEqual(
    (await keysOf(session, "?label=web&label=perf")).sort(),
    [web.key, perf.key, other.key].sort(),
  );
  assert.deepEqual(await keysOf(session, "?label=web&assignee=owner"), [web.key]);
  assert.deepEqual(
    (await keysOf(session, "?status=TODO&status=BACKLOG")).sort(),
    [web.key, perf.key, other.key].sort(),
  );
  assert.deepEqual(
    (await keysOf(session, "?status=TODO&assignee=owner&label=web")).sort(),
    [web.key],
  );
});

test("claimable excludes issues held up by an unfinished blocker", async (t) => {
  const session = await makeSession(t);
  const blocker = await make(session, "선행");
  const blocked = await make(session, "후행");
  const free = await make(session, "자유");

  await call(session, "POST", `/issues/${blocked.key}/links`, {
    ifMatch: (await call(session, "GET", `/issues/${blocked.key}`)).etag ?? "",
    body: { kind: "blocked_by", to: blocker.uid },
  });

  let claimable = await keysOf(session, "?claimable=true");
  assert.equal(claimable.includes(blocked.key), false, "the blocked one is out");
  assert.equal(claimable.includes(free.key), true);

  // Finishing the blocker puts it back in scope without anything else changing.
  await moveTo(session, blocker.key, "DONE");
  claimable = await keysOf(session, "?claimable=true");
  assert.equal(claimable.includes(blocked.key), true);
});

test("a relation declared from the other side still blocks", async (t) => {
  const session = await makeSession(t);
  const blocker = await make(session, "선행");
  const blocked = await make(session, "후행");

  // `A blocks B` on A is the same relation as `B blocked_by A` on B (S1-D4).
  // Looking at only one direction would leave half the blockers invisible here.
  await call(session, "POST", `/issues/${blocker.key}/links`, {
    ifMatch: (await call(session, "GET", `/issues/${blocker.key}`)).etag ?? "",
    body: { kind: "blocks", to: blocked.uid },
  });

  const claimable = await keysOf(session, "?claimable=true");
  assert.equal(claimable.includes(blocked.key), false);
  assert.equal(claimable.includes(blocker.key), true);
});

test("an unknown filter value is refused with the allowed ones", async (t) => {
  const session = await makeSession(t);
  await make(session, "이슈");

  const badStatus = await call(session, "GET", "/issues?status=REVIEWING");
  assert.equal(badStatus.status, 400);
  const body = badStatus.json as unknown as { error: { code: string; detail: string } };
  assert.equal(body.error.code, "E_INVALID_FILTER");
  assert.match(body.error.detail, /IN_REVIEW/, "the allowed values are listed");

  const badType = await call(session, "GET", "/issues?type=chore");
  assert.equal(badType.status, 400);

  const badClaimable = await call(session, "GET", "/issues?claimable=maybe");
  assert.equal(badClaimable.status, 400);

  // §4 S3 writes this form, and answering it with an empty list would read as
  // "no work available" rather than "sprints do not exist yet".
  const notYet = await call(session, "GET", "/issues?sprint=active");
  assert.equal(notYet.status, 400);
  assert.equal(
    (notYet.json as unknown as { error: { code: string } }).error.code,
    "E_FILTER_UNSUPPORTED",
  );
});

test("quarantined issues are absent from the list and its point total", async (t) => {
  const session = await makeSession(t);
  const good = await make(session, "멀쩡", { points: 3 });
  const broken = await make(session, "깨질 것", { points: 8 });

  fs.writeFileSync(
    path.join(session.board, "issues", "LJ", `${broken.key}.md`),
    "---\nuid: [unclosed\n---\n",
  );
  await session.server.reconcile();

  const listed = await call(session, "GET", "/issues");
  const body = listed.json as unknown as { issues: Array<{ key: string }>; points: number };
  assert.deepEqual(body.issues.map((issue) => issue.key), [good.key]);
  assert.equal(body.points, 3, "the quarantined issue's points are out of the total too");
});

test("paging is stable when the list is reordered underneath it", async (t) => {
  const session = await makeSession(t);
  const made = [];
  for (let index = 0; index < 6; index += 1) {
    made.push(await make(session, `이슈 ${index}`));
  }

  const first = await call(session, "GET", "/issues?limit=3");
  const firstPage = first.json as unknown as {
    issues: Array<{ key: string }>;
    hasMore: boolean;
    nextAfter: string;
  };
  assert.equal(firstPage.issues.length, 3);
  assert.equal(firstPage.hasMore, true);

  // Reorder while the caller holds a cursor. An offset would now skip or repeat
  // rows silently; a key-based cursor still means the same place in the order.
  await call(session, "POST", `/issues/${made[5].key}/rank`, {
    body: { field: "backlog_rank", after: null, before: made[0].uid },
  });

  const second = await call(session, "GET", `/issues?limit=3&after=${firstPage.nextAfter}`);
  const secondPage = second.json as unknown as { issues: Array<{ key: string }> };

  const overlap = secondPage.issues
    .map((issue) => issue.key)
    .filter((key) => firstPage.issues.some((issue) => issue.key === key));
  assert.deepEqual(overlap, [], "no issue appeared on both pages");
});

test("the same filter gives the same answer after the index is thrown away", async (t) => {
  const session = await makeSession(t);
  for (const [title, labels] of [["A", ["web"]], ["B", ["perf"]], ["C", ["web"]]] as const) {
    await make(session, title, { labels: [...labels] });
  }

  const before = await keysOf(session, "?label=web");
  assert.equal(before.length, 2);
  await session.server.close();

  fs.rmSync(path.join(session.board, ".local", "index.sqlite"));
  await session.restart();

  // AC2: the index is a cache, so losing it must not change an answer.
  assert.deepEqual(await keysOf(session, "?label=web"), before);
});

test("five thousand issues filter well inside the budget", { timeout: 180_000 }, async (t) => {
  const session = await makeSession(t);
  await session.server.close();

  const directory = path.join(session.board, "issues", "LJ");
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 1; index <= 5_000; index += 1) {
    fs.writeFileSync(
      path.join(directory, `LJ-${index + 100}.md`),
      `---\nuid: 01JBULK${String(index).padStart(19, "0")}\nkey: LJ-${index + 100}\n` +
        `type: task\ntitle: 대량 ${index}\nstatus: ${index % 3 === 0 ? "TODO" : "BACKLOG"}\n` +
        `labels: [${index % 2 === 0 ? "web" : "perf"}]\n` +
        `backlog_rank: "${String(index).padStart(6, "0")}"\n---\n\n`,
    );
  }
  await session.restart();

  const timings: number[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const started = performance.now();
    const listed = await call(session, "GET", "/issues?status=TODO&label=web&claimable=true&limit=100");
    assert.equal(listed.status, 200);
    timings.push(performance.now() - started);
  }

  timings.sort((a, b) => a - b);
  const p95 = timings[Math.floor(timings.length * 0.95) - 1];
  assert.ok(p95 < 300, `p95 was ${p95.toFixed(0)}ms against a 300ms budget (AC13, N1)`);
  process.stdout.write(`      (5,000 issues, combined filter: p95 ${p95.toFixed(0)}ms)\n`);
});
