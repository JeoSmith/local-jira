import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writeSnapshots, type Snapshot } from "../../src/domain/burndown.ts";
import { startServer, type RunningServer } from "../../src/server/http.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

interface Session {
  server: RunningServer;
  repo: string;
  board: string;
  admin: string;
  sprint: string;
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

interface Result {
  status: number;
  json: Record<string, never>;
  etag: string | null;
}

async function call(
  s: Session,
  method: string,
  route: string,
  options: { body?: unknown; etag?: string } = {},
): Promise<Result> {
  const response = await fetch(`${s.server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: s.admin,
      ...(options.etag ? { "if-match": options.etag } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
    etag: response.headers.get("etag"),
  };
}

async function session(
  t: { after: (fn: () => void | Promise<void>) => void },
  options: { start?: boolean } = {},
): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-burn-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
  assert.equal(
    cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]).status,
    0,
  );
  cli(repo, ["admin", "create", "--id", "root", "--name", "루트", "--password", PASSWORD]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const server = await startServer({ cwd: repo, port: 0, watch: false });
  t.after(() => server.close());

  const login = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "root", password: PASSWORD }),
  });
  const partial: Session = {
    server, repo,
    board: path.join(repo, ".localjira"),
    admin: (login.headers.get("set-cookie") ?? "").split(";")[0],
    sprint: "",
  };

  const created = await call(partial, "POST", "/projects/LJ/sprints", {
    body: { name: "Sprint A" },
  });
  partial.sprint = created.json.id as unknown as string;
  if (options.start !== false) {
    assert.equal((await call(partial, "POST", `/sprints/${partial.sprint}/start`)).status, 200);
  }
  return partial;
}

/** An issue in the sprint, optionally moved on and optionally sized. */
async function scoped(
  s: Session,
  title: string,
  points: number | null,
  status?: "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "CANCELLED",
): Promise<string> {
  const created = await call(s, "POST", "/issues", {
    body: { project: "LJ", type: "task", title, points },
  });
  const key = created.json.key as unknown as string;
  assert.equal(
    (await call(s, "POST", `/sprints/${s.sprint}/issues`, { body: { keys: [key] } })).status,
    200,
  );

  const path: Record<string, string[]> = {
    TODO: ["TODO"],
    IN_PROGRESS: ["TODO", "IN_PROGRESS"],
    IN_REVIEW: ["TODO", "IN_PROGRESS", "IN_REVIEW"],
    DONE: ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"],
    CANCELLED: ["CANCELLED"],
  };
  for (const to of status === undefined ? [] : path[status]) {
    const current = await call(s, "GET", `/issues/${key}`);
    const moved = await call(s, "POST", `/issues/${key}/transitions`, {
      etag: current.etag ?? undefined, body: { to },
    });
    assert.equal(moved.status, 200, `${key} → ${to}: ${JSON.stringify(moved.json)}`);
  }
  return key;
}

async function chart(s: Session): Promise<Record<string, never>> {
  const found = await call(s, "GET", `/sprints/${s.sprint}/burndown`);
  assert.equal(found.status, 200, JSON.stringify(found.json));
  return found.json;
}

// ── the denominator (AC23, D8) ──────────────────────────────────────────────

test("cancelled and unestimated issues are outside both numbers", async (t) => {
  const s = await session(t);
  await scoped(s, "5점", 5);
  await scoped(s, "8점", 8);
  await scoped(s, "3점", 3);
  await scoped(s, "취소된 5점", 5, "CANCELLED");
  await scoped(s, "무추정 1", null);
  await scoped(s, "무추정 2", null);

  const found = await chart(s);
  const current = found.current as unknown as Record<string, number>;

  // AC23's own example: 5 + 8 + 3, and the cancelled 5 is not in it.
  assert.equal(current.scope_points, 16);
  // Reported beside the total, so the chart cannot pass itself off as covering
  // a scope it does not (D8).
  assert.equal(current.unestimated, 2);
  assert.equal(current.cancelled, 1);
});

test("an unestimated issue reaching DONE stays out of the numerator too", async (t) => {
  const s = await session(t);
  await scoped(s, "5점", 5, "DONE");
  await scoped(s, "무추정", null, "DONE");

  const current = (await chart(s)).current as unknown as Record<string, number>;
  // Taken out of the denominator, so it cannot be added to the numerator —
  // otherwise completion could exceed 100%.
  assert.equal(current.scope_points, 5);
  assert.equal(current.done_points, 5);
  assert.equal((await chart(s)).completion, 100);
});

test("only DONE counts as done", async (t) => {
  const s = await session(t);
  await scoped(s, "검토 중", 5, "IN_REVIEW");
  await scoped(s, "진행 중", 3, "IN_PROGRESS");
  await scoped(s, "끝난 것", 2, "DONE");

  const current = (await chart(s)).current as unknown as Record<string, number>;
  // §5.2: IN_REVIEW is work in flight, not work finished.
  assert.equal(current.scope_points, 10);
  assert.equal(current.done_points, 2);
});

test("nothing estimated is not zero per cent", async (t) => {
  const s = await session(t);
  await scoped(s, "무추정만", null);

  const found = await chart(s);
  // "nothing is estimated" and "nothing is done" are different states, and 0%
  // would report the first as the second.
  assert.equal(found.completion, null);
  assert.equal((found.current as unknown as Record<string, number>).unestimated, 1);
});

test("a quarantined issue is left out, and said to be", async (t) => {
  const s = await session(t);
  const key = await scoped(s, "깨질 이슈", 5);
  await scoped(s, "멀쩡한 이슈", 3);

  fs.appendFileSync(
    path.join(s.board, "issues", "LJ", `${key}.md`),
    "\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> z\n",
  );
  await call(s, "POST", "/index/rebuild");

  const found = await chart(s);
  // §5.6: counting a document the board cannot parse would be inventing a
  // number, and silently dropping it would be inventing a smaller scope.
  assert.equal((found.current as unknown as Record<string, number>).scope_points, 3);

  // Board-wide rather than per sprint, because after a rebuild there is no row
  // left to say which sprint the file belonged to. Reporting it as this
  // sprint's would be a number nothing supports.
  assert.equal(found.unindexed, 1);
});

// ── the scope line (AC23) ───────────────────────────────────────────────────

test("scope added mid-sprint shows as a rise, not as progress", async (t) => {
  const s = await session(t);
  await scoped(s, "처음부터 있던 일", 24);

  const before = (await chart(s)).current as unknown as Record<string, number>;
  assert.equal(before.scope_points, 24);

  await scoped(s, "중간에 들어온 일", 5);

  const after = (await chart(s)).current as unknown as Record<string, number>;
  // AC23: 24 → 29 on its own series. Folded into the remaining line it would
  // look like the team went backwards.
  assert.equal(after.scope_points, 29);
  assert.equal(after.done_points, 0);
});

test("cancelling mid-sprint lowers the scope line and not the done line", async (t) => {
  const s = await session(t);
  const doomed = await scoped(s, "취소될 일", 8);
  await scoped(s, "남을 일", 5);

  assert.equal(
    ((await chart(s)).current as unknown as Record<string, number>).scope_points,
    13,
  );

  const current = await call(s, "GET", `/issues/${doomed}`);
  await call(s, "POST", `/issues/${doomed}/transitions`, {
    etag: current.etag ?? undefined, body: { to: "CANCELLED" },
  });

  const after = (await chart(s)).current as unknown as Record<string, number>;
  assert.equal(after.scope_points, 5, "the scope came down");
  assert.equal(after.done_points, 0, "and nothing was completed by cancelling it");
  assert.equal(after.cancelled, 1);
});

// ── snapshots (D12, S4-D7, S4-D8) ───────────────────────────────────────────

test("the snapshot lives in the sprint file, not in the event log", async (t) => {
  const s = await session(t);
  await scoped(s, "일", 5, "DONE");

  const file = path.join(s.board, "sprints", "LJ", `${s.sprint}.yaml`);
  const text = fs.readFileSync(file, "utf8");

  // D12: the event log is collaboration history, not tamper-evident (§5.7).
  // A chart resting on it is one nobody can quote.
  assert.match(text, /^burndown_snapshots:/m);
  assert.match(text, /done_points: 5/);
});

test("one row per day, and the last write of the day wins", async (t) => {
  const s = await session(t);
  await scoped(s, "첫 일", 5);
  await scoped(s, "둘째 일", 3);
  await scoped(s, "셋째 일", 2, "DONE");

  const file = path.join(s.board, "sprints", "LJ", `${s.sprint}.yaml`);
  const rows = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().startsWith("- {date:"));

  // S4-D7: several writes in a day leave one row, holding that day's last
  // state — otherwise a busy day would balloon the file.
  assert.equal(rows.length, 1, rows.join("\n"));
  assert.match(rows[0], /scope_points: 10/);
  assert.match(rows[0], /done_points: 2/);
});

test("snapshots survive losing the index", async (t) => {
  const s = await session(t);
  await scoped(s, "일", 8, "DONE");
  await scoped(s, "다른 일", 5);

  const before = await chart(s);
  await call(s, "POST", "/index/rebuild");
  const after = await chart(s);

  // AC2: they are in a file, so the same graph comes back.
  assert.deepEqual(after.snapshots, before.snapshots);
  assert.equal(after.completion, before.completion);
});

test("history from earlier days is kept and ordered", async (t) => {
  const s = await session(t);
  await scoped(s, "일", 10, "DONE");

  // Two days that the running server never saw, which is what a board looks
  // like after a week of use.
  const file = path.join(s.board, "sprints", "LJ", `${s.sprint}.yaml`);
  const past: Snapshot[] = [
    { date: "2026-07-02", scopePoints: 10, donePoints: 0, unestimated: 0, cancelled: 0, quarantined: 0 },
    { date: "2026-07-01", scopePoints: 10, donePoints: 0, unestimated: 0, cancelled: 0, quarantined: 0 },
  ];
  fs.writeFileSync(file, writeSnapshots(fs.readFileSync(file, "utf8"), past));
  await call(s, "POST", "/index/rebuild");

  const found = await chart(s);
  const dates = (found.snapshots as unknown as Array<{ date: string }>).map((e) => e.date);
  assert.equal(dates.length, 3, dates.join(", "));
  assert.deepEqual([...dates].sort(), dates, "oldest first, whatever order the file held");
  assert.equal(dates[0], "2026-07-01");
});

test("a gap is a gap: no value is invented for a day nobody was watching", async (t) => {
  const s = await session(t);
  await scoped(s, "일", 10);

  const file = path.join(s.board, "sprints", "LJ", `${s.sprint}.yaml`);
  const past: Snapshot[] = [
    { date: "2026-07-01", scopePoints: 10, donePoints: 0, unestimated: 0, cancelled: 0, quarantined: 0 },
    { date: "2026-07-05", scopePoints: 10, donePoints: 4, unestimated: 0, cancelled: 0, quarantined: 0 },
  ];
  fs.writeFileSync(file, writeSnapshots(fs.readFileSync(file, "utf8"), past));
  await call(s, "POST", "/index/rebuild");

  const dates = ((await chart(s)).snapshots as unknown as Array<{ date: string }>)
    .map((entry) => entry.date);

  // S4-D8: the days between are missing because nobody measured them. Filling
  // them in would make the chart say work stopped when in fact nobody looked.
  assert.equal(dates.includes("2026-07-02"), false, dates.join(", "));
  assert.equal(dates.includes("2026-07-03"), false);
});

test("a planned sprint reports its scope and no history", async (t) => {
  const s = await session(t, { start: false });
  await scoped(s, "계획된 일", 13);

  const found = await chart(s);
  assert.equal(found.status, "PLANNED");
  assert.equal((found.current as unknown as Record<string, number>).scope_points, 13);
  // Nothing has started, so there is no elapsed time to plot.
  assert.equal((found.snapshots as unknown as unknown[]).length, 1);

  const file = path.join(s.board, "sprints", "LJ", `${s.sprint}.yaml`);
  assert.equal(
    fs.readFileSync(file, "utf8").includes("burndown_snapshots:"),
    false,
    "and nothing was written to the file",
  );
});

test("a closed sprint still answers", async (t) => {
  const s = await session(t);
  await scoped(s, "끝낸 일", 5, "DONE");
  await call(s, "POST", `/sprints/${s.sprint}/close`, { body: { carry_over: { to: null } } });

  const found = await chart(s);
  assert.equal(found.status, "CLOSED");
  assert.equal(found.completion, 100);
  assert.ok((found.snapshots as unknown as unknown[]).length >= 1, "the history stays");
});

// ── the writer on its own ───────────────────────────────────────────────────

test("writing snapshots twice replaces rather than piles up", () => {
  const original = "schema_version: 1\nid: LJ-S1\nname: A\n";
  const one: Snapshot = {
    date: "2026-07-01", scopePoints: 10, donePoints: 0,
    unestimated: 0, cancelled: 0, quarantined: 0,
  };
  const two: Snapshot = { ...one, date: "2026-07-02", donePoints: 3 };

  const first = writeSnapshots(original, [one]);
  const second = writeSnapshots(first, [one, two]);
  const third = writeSnapshots(second, [one, two]);

  assert.equal(second, third, "writing the same thing twice changes nothing");
  assert.equal(second.split("- {date:").length - 1, 2);
  // The rest of the document is untouched — this is a patch, not a rewrite.
  assert.match(second, /^id: LJ-S1$/m);
  assert.match(second, /^schema_version: 1$/m);
});
