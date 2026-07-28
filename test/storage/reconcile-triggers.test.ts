import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer } from "../../src/server/http.ts";
import { openBoardForWriting } from "../../src/storage/board.ts";
import { fullReconcile } from "../../src/storage/reconcile.ts";
import { watchBoard, type Escalation } from "../../src/storage/watcher.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

interface Sandbox {
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

function cli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

function makeSandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-trigger-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "Trigger"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
  cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]);

  const board = path.join(repo, ".localjira");
  fs.mkdirSync(path.join(board, "issues", "LJ"), { recursive: true });
  return { repo, board };
}

/** Collects the escalations a watcher reports, so a test can assert on them. */
function collect(
  t: { after: (fn: () => void) => void },
  boardRoot: string,
  options: { overflowEvents?: number } = {},
): {
  seen: Array<Escalation | null>;
  arm(): Promise<void>;
  settle(predicate?: () => boolean): Promise<void>;
} {
  const seen: Array<Escalation | null> = [];
  const watcher = watchBoard(boardRoot, {
    debounceMs: 20,
    overflowEvents: options.overflowEvents,
    onBatch: (_paths, escalation) => seen.push(escalation),
  });
  t.after(() => watcher.close());

  // Polled rather than slept on. fs.watch delivery is not bounded by any
  // interval the test can pick, and a fixed sleep that is long enough on an
  // idle laptop is not long enough on a loaded CI runner — that is how a test
  // ends up passing for reasons unrelated to what it checks.
  const armed = async (): Promise<void> => {
    // fs.watch does not report when it is live, and an event that happens
    // before it is loses no time — it is simply never delivered. So provoke one
    // and wait for it: once something has come through, the watcher is
    // demonstrably armed and the rest of the test is measuring what it means to.
    const probe = path.join(boardRoot, ".watch-probe");
    const deadline = Date.now() + 10_000;
    while (seen.length === 0 && Date.now() < deadline) {
      fs.writeFileSync(probe, String(Date.now()));
      await new Promise((resolve) => setTimeout(resolve, 40));
      watcher.flush();
    }
    fs.rmSync(probe, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    watcher.flush();
    seen.length = 0;
  };

  return {
    seen,
    arm: armed,
    async settle(predicate = () => seen.length > 0) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        watcher.flush();
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      watcher.flush();
    },
  };
}

test("an ordinary edit is not promoted to a full reconcile", async (t) => {
  const sandbox = makeSandbox(t);
  const watch = collect(t, sandbox.board);
  await watch.arm();

  fs.writeFileSync(path.join(sandbox.board, "issues", "LJ", "LJ-1.md"), "---\nkey: LJ-1\n---\n");
  await watch.settle();

  assert.ok(watch.seen.length > 0, "the watcher saw the write");
  assert.deepEqual(
    watch.seen.filter((entry) => entry !== null),
    [],
    "one file changing is exactly what the incremental path is for",
  );
});

test("a flood of events gives up on the list and reconciles everything", async (t) => {
  const sandbox = makeSandbox(t);
  // A threshold of 3 keeps the test honest without writing 200 files: the
  // question is whether crossing it promotes, not what the number is.
  const watch = collect(t, sandbox.board, { overflowEvents: 3 });
  await watch.arm();

  const directory = path.join(sandbox.board, "issues", "LJ");
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(path.join(directory, `LJ-${index}.md`), `---\nkey: LJ-${index}\n---\n`);
  }
  await watch.settle(() => watch.seen.includes("watcher_overflow"));

  assert.ok(
    watch.seen.includes("watcher_overflow"),
    `expected an overflow escalation, saw ${JSON.stringify(watch.seen)}`,
  );
});

test("a git operation on the board promotes without waiting for file events", async (t) => {
  const sandbox = makeSandbox(t);
  const watch = collect(t, sandbox.board);
  await watch.arm();

  // Touch HEAD the way a checkout does. The board's own files are untouched, so
  // nothing else here would have suggested a reconcile is due.
  const headPath = git(sandbox.board, ["rev-parse", "--git-path", "HEAD"]).trim();
  const absolute = path.isAbsolute(headPath) ? headPath : path.join(sandbox.board, headPath);
  fs.appendFileSync(absolute, "");
  fs.writeFileSync(absolute, fs.readFileSync(absolute));

  await watch.settle(() => watch.seen.includes("git_head_change"));

  assert.ok(
    watch.seen.includes("git_head_change"),
    `expected a git escalation, saw ${JSON.stringify(watch.seen)}`,
  );
});

test("a pull that adds, edits and deletes lands without restarting the server", async (t) => {
  const sandbox = makeSandbox(t);
  cli(sandbox.repo, ["admin", "create", "--id", "teammate", "--name", "팀원", "--password", PASSWORD]);

  const kept = JSON.parse(
    cli(sandbox.repo, [
      "issue", "create", "--project", "LJ", "--type", "task", "--title", "수정될 것", "--json",
    ]).stdout,
  ) as { key: string };
  const removed = JSON.parse(
    cli(sandbox.repo, [
      "issue", "create", "--project", "LJ", "--type", "task", "--title", "삭제될 것", "--json",
    ]).stdout,
  ) as { key: string };

  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  t.after(() => server.close());

  const login = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "teammate", password: PASSWORD }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const list = async (): Promise<string[]> => {
    const response = await fetch(`${server.url}/issues`, { headers: { cookie } });
    const body = (await response.json()) as { issues: Array<{ key: string }> };
    return body.issues.map((issue) => issue.key).sort();
  };

  assert.deepEqual(await list(), [kept.key, removed.key].sort());

  // What arriving from someone else's push looks like on disk: one edited, one
  // deleted, one appearing out of nowhere.
  const directory = path.join(sandbox.board, "issues", "LJ");
  const keptFile = path.join(directory, `${kept.key}.md`);
  fs.writeFileSync(
    keptFile,
    fs.readFileSync(keptFile, "utf8").replace(/^title: .*$/m, "title: 팀원이 고침"),
  );
  fs.rmSync(path.join(directory, `${removed.key}.md`));
  fs.writeFileSync(
    path.join(directory, "LJ-500.md"),
    `---\nuid: 01JPULLED${"0".repeat(17)}\nkey: LJ-500\ntype: task\ntitle: 팀원이 만든 것\nstatus: BACKLOG\n---\n\n`,
  );

  await server.reconcile();

  assert.deepEqual(await list(), [kept.key, "LJ-500"].sort(), "all three changes are visible");

  const shown = await fetch(`${server.url}/issues/${kept.key}`, { headers: { cookie } });
  assert.equal(((await shown.json()) as { title: string }).title, "팀원이 고침");

  // The deleted one answers with where it used to be rather than pretending it
  // never existed.
  const gone = await fetch(`${server.url}/issues/${removed.key}`, { headers: { cookie } });
  assert.equal(gone.status, 404);
  const error = (await gone.json()) as { error: { detail: string | null } };
  assert.match(String(error.error.detail), new RegExp(`issues/LJ/${removed.key}\\.md`));
});

test("a removed worktree is refused rather than read as an empty board", async (t) => {
  const sandbox = makeSandbox(t);
  cli(sandbox.repo, [
    "issue", "create", "--project", "LJ", "--type", "task", "--title", "지켜야 할 것",
  ]);

  // Keep .local/ (the index) and take away everything git tracks — the state a
  // `git worktree remove` leaves behind.
  for (const entry of fs.readdirSync(sandbox.board)) {
    if (entry !== ".local") {
      fs.rmSync(path.join(sandbox.board, entry), { recursive: true, force: true });
    }
  }

  const result = cli(sandbox.repo, ["index", "status"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /E_WORKTREE_MISSING/);
  assert.match(result.stderr, /repair-worktree/, "the recovery command is named");
  assert.doesNotMatch(result.stderr, /Run localjira init/, "init would start a new board");

  // And the index still remembers, so nothing was thrown away on the way out.
  assert.equal(fs.existsSync(path.join(sandbox.board, ".local", "index.sqlite")), true);
});

test("a thousand changed files reconcile well inside the budget", { timeout: 120_000 }, async (t) => {
  const sandbox = makeSandbox(t);
  const directory = path.join(sandbox.board, "issues", "LJ");
  const write = (index: number, title: string): void => {
    fs.writeFileSync(
      path.join(directory, `LJ-${index}.md`),
      `---\nuid: 01JBULK${String(index).padStart(19, "0")}\nkey: LJ-${index}\n` +
        `type: task\ntitle: ${title} ${index}\nstatus: BACKLOG\n---\n\n`,
    );
  };

  for (let index = 1; index <= 1_000; index += 1) {
    write(index, "처음");
  }

  // Open once so the index is current, then change all thousand underneath it —
  // the state a `git pull` leaves a running server in.
  const board = await openBoardForWriting(sandbox.repo);
  t.after(() => board.close());
  for (let index = 1; index <= 1_000; index += 1) {
    write(index, "팀원이 바꾼");
  }

  const report = fullReconcile(sandbox.board, board.board.db, { reason: "git_head_change" });

  assert.equal(report.reason, "git_head_change", "the trigger is recorded");
  assert.ok(report.changed.length >= 1_000, `only ${report.changed.length} files were picked up`);
  assert.equal(report.hashed, report.scanned, "a full pass hashes everything it scans");

  const row = board.board.db
    .prepare("SELECT title FROM issues WHERE key = 'LJ-500'")
    .get() as { title: string };
  assert.equal(row.title, "팀원이 바꾼 500", "the new content is what got indexed");

  // N2 allows 15s. The margin matters more than the number: if this ever gets
  // close, reconciliation has stopped being something that can run on a pull.
  assert.ok(
    report.durationMs < 15_000,
    `full reconcile of 1,000 changed files took ${report.durationMs}ms, budget is 15,000ms`,
  );
  process.stdout.write(`      (1,000 files reconciled in ${report.durationMs}ms)\n`);
});
