import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../fixtures/cli-token.ts";

import { BootstrapBusyError } from "../../src/bootstrap/lock.ts";
import { Outbox } from "../../src/storage/outbox.ts";
import {
  openBoardForWriting,
  SERVER_LOCK_FILENAME,
  type WritableBoard,
} from "../../src/storage/board.ts";
import { fileHash, parseMarkdownResource } from "../../src/storage/resource.ts";
import { WriteConflictError, type CrashPoint } from "../../src/storage/writer.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/** The write pipeline's durable stages, in order (design §3.4). */
const CRASH_POINTS: CrashPoint[] = [
  "after_outbox",
  "before_rename",
  "after_rename",
  "after_index",
  "after_event",
];

interface Sandbox {
  repo: string;
  board: string;
  open(): Promise<WritableBoard>;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout;
}

function cli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  // r13c: `issue create` needs a token, which runCli mints for this board.
  return runCli(cwd, args, env);
}

function makeSandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-writer-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  const init = cli(repo, [
    "init", "--project-key", "LJ", "--project-name", "Local Jira", "--timezone", "Asia/Seoul",
  ]);
  assert.equal(init.status, 0, init.stderr);

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { repo, board: path.join(repo, ".localjira"), open: () => openBoardForWriting(repo) };
}

function issueFiles(sandbox: Sandbox): string[] {
  const directory = path.join(sandbox.board, "issues", "LJ");
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

function eventLines(sandbox: Sandbox): Array<Record<string, unknown>> {
  const root = path.join(sandbox.board, "events");
  if (!fs.existsSync(root)) {
    return [];
  }
  const lines: Array<Record<string, unknown>> = [];
  for (const day of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, day))) {
      for (const line of fs.readFileSync(path.join(root, day, file), "utf8").split("\n")) {
        if (line.trim() === "") {
          continue;
        }
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return lines;
}

// ── single writer ───────────────────────────────────────────────────────────

test("refuses a second writer on the same board", async (t) => {
  const sandbox = makeSandbox(t);
  const first = await sandbox.open();
  t.after(() => first.close());

  await assert.rejects(() => sandbox.open(), BootstrapBusyError);
});

test("takes over after the previous writer died without releasing", async (t) => {
  const sandbox = makeSandbox(t);

  // A crashed process leaves the lock file behind; the kernel drops the lock.
  const crashed = cli(sandbox.repo, [
    "issue", "create", "--project", "LJ", "--type", "story", "--title", "x",
  ], { LOCALJIRA_WRITE_CRASH_AT: "after_outbox" });
  assert.notEqual(crashed.status, 0);
  assert.equal(fs.existsSync(path.join(sandbox.board, ".local", SERVER_LOCK_FILENAME)), true);

  const board = await sandbox.open();
  t.after(() => board.close());
  assert.ok(board.writer.replayComplete);
});

test("serialises concurrent writes to the same path", async (t) => {
  const sandbox = makeSandbox(t);
  const board = await sandbox.open();
  t.after(() => board.close());

  const target = "issues/LJ/LJ-1.md";
  const render = (title: string): string =>
    `---\nuid: 01JCONC${"0".repeat(19)}\nkey: LJ-1\ntype: task\ntitle: ${title}\nstatus: BACKLOG\n---\n\n`;

  await board.writer.write({
    kind: "create", targetPath: target, contents: render("base"),
    expectedHash: null, actorId: "u", actorKind: "human",
  });
  const base = fileHash(Buffer.from(render("base"), "utf8"));

  // Five updates from the same read, all issued before any of them resolves.
  // This is the race the mutex exists for: nothing here awaits anything else,
  // so without serialisation they interleave on one file.
  const names = ["a", "b", "c", "d", "e"];
  const settled = await Promise.allSettled(
    names.map((name) =>
      board.writer.write({
        kind: "update", targetPath: target, contents: render(name),
        expectedHash: base, actorId: "u", actorKind: "human",
      }),
    ),
  );

  const winners = settled.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1, "only one write may win from a shared base");

  for (const loser of settled.filter((result) => result.status !== "fulfilled")) {
    // A lost update has to be refused. Silently applying it is the failure this
    // whole mechanism exists to prevent.
    assert.ok(
      (loser as PromiseRejectedResult).reason instanceof WriteConflictError,
      `expected a conflict, got ${String((loser as PromiseRejectedResult).reason)}`,
    );
  }

  // The survivor is one complete document, not a blend of five writers.
  const parsed = parseMarkdownResource(fs.readFileSync(path.join(sandbox.board, target)));
  assert.ok(
    names.includes((parsed.frontmatter as Record<string, unknown>).title as string),
    "the file must hold exactly one writer's content",
  );
});

test("a writer that re-reads after each write loses nothing", async (t) => {
  const sandbox = makeSandbox(t);
  const board = await sandbox.open();
  t.after(() => board.close());

  const target = "issues/LJ/LJ-2.md";
  const render = (title: string): string =>
    `---\nuid: 01JSEQ0${"0".repeat(19)}\nkey: LJ-2\ntype: task\ntitle: ${title}\nstatus: BACKLOG\n---\n\n`;

  await board.writer.write({
    kind: "create", targetPath: target, contents: render("v0"),
    expectedHash: null, actorId: "u", actorKind: "human",
  });

  // The other half of the acceptance criterion: given a fresh precondition each
  // time, every write lands rather than being rejected as a conflict.
  for (let version = 1; version <= 5; version += 1) {
    await board.writer.write({
      kind: "update", targetPath: target, contents: render(`v${version}`),
      expectedHash: fileHash(Buffer.from(render(`v${version - 1}`), "utf8")),
      actorId: "u", actorKind: "human",
    });
  }

  const parsed = parseMarkdownResource(fs.readFileSync(path.join(sandbox.board, target)));
  assert.equal((parsed.frontmatter as Record<string, unknown>).title, "v5");
});

test("refuses a write whose expected hash no longer matches", async (t) => {
  const sandbox = makeSandbox(t);
  const board = await sandbox.open();
  t.after(() => board.close());

  await assert.rejects(
    () =>
      board.writer.write({
        kind: "update",
        targetPath: "issues/LJ/LJ-404.md",
        contents: "---\nkey: LJ-404\n---\n\n",
        expectedHash: "0".repeat(64),
        actorId: "u",
        actorKind: "human",
      }),
    WriteConflictError,
  );
});

// ── fault injection ─────────────────────────────────────────────────────────

for (const point of CRASH_POINTS) {
  test(`recovers from a crash ${point}`, async (t) => {
    const sandbox = makeSandbox(t);

    const crashed = cli(
      sandbox.repo,
      ["issue", "create", "--project", "LJ", "--type", "story", "--title", "크래시 테스트", "--points", "3"],
      { LOCALJIRA_WRITE_CRASH_AT: point },
    );
    assert.ok(
      crashed.signal === "SIGABRT" || crashed.status !== 0,
      `expected an aborted write, got status=${crashed.status} signal=${crashed.signal}`,
    );

    // Whatever landed on disk must be a whole file, never half a document.
    for (const name of issueFiles(sandbox)) {
      const bytes = fs.readFileSync(path.join(sandbox.board, "issues", "LJ", name));
      assert.doesNotThrow(
        () => parseMarkdownResource(bytes),
        `${name} was left partially written after crashing ${point}`,
      );
    }
    // Restarting replays whatever was unfinished.
    const board = await sandbox.open();
    t.after(() => board.close());
    assert.ok(board.writer.replayComplete);

    // A crash cannot run its own cleanup, so recovery sweeps the temp file it
    // left behind; otherwise a clean board would show as dirty in git.
    assert.equal(
      issueFiles(sandbox).some((name) => name.endsWith(".tmp")),
      false,
      "a leftover temp file survived the replay",
    );

    const files = issueFiles(sandbox);
    if (files.length > 0) {
      // Rolled forward: the issue, its index row and exactly one event.
      const issues = board.board.db.prepare("SELECT key FROM issues").all() as Array<{ key: string }>;
      assert.deepEqual(issues.map((row) => row.key), ["LJ-1"]);

      const events = eventLines(sandbox).filter((event) => event.verb === "issue.created");
      assert.equal(events.length, 1, `duplicate events after crashing ${point}`);
    }
  });
}

test("replaying twice is the same as replaying once", async (t) => {
  const sandbox = makeSandbox(t);

  cli(
    sandbox.repo,
    ["issue", "create", "--project", "LJ", "--type", "story", "--title", "반복 재생"],
    { LOCALJIRA_WRITE_CRASH_AT: "after_rename" },
  );

  const first = await sandbox.open();
  const afterFirst = {
    issues: first.board.db.prepare("SELECT key, etag FROM issues ORDER BY key").all(),
    events: eventLines(sandbox).length,
  };
  await first.close();

  const second = await sandbox.open();
  t.after(() => second.close());

  assert.equal(second.replay.replayed, 0, "nothing is left to replay");
  assert.deepEqual(
    second.board.db.prepare("SELECT key, etag FROM issues ORDER BY key").all(),
    afterFirst.issues,
  );
  assert.equal(eventLines(sandbox).length, afterFirst.events, "no event was appended twice");
});

test("abandons a replay rather than overwriting a file someone repaired", async (t) => {
  const sandbox = makeSandbox(t);

  // Crash before the file was written, so the outbox still wants to write it.
  cli(
    sandbox.repo,
    ["issue", "create", "--project", "LJ", "--type", "story", "--title", "롤포워드 대상"],
    { LOCALJIRA_WRITE_CRASH_AT: "before_rename" },
  );

  // Then a person puts something else at that path.
  const repaired = `---\nuid: 01JHAND${"0".repeat(19)}\nkey: LJ-1\ntype: task\ntitle: 사람이 고친 내용\nstatus: BACKLOG\n---\n손으로 쓴 본문\n`;
  fs.mkdirSync(path.join(sandbox.board, "issues", "LJ"), { recursive: true });
  fs.writeFileSync(path.join(sandbox.board, "issues", "LJ", "LJ-1.md"), repaired);

  const board = await sandbox.open();
  t.after(() => board.close());

  // The pending write must not win: rolling forward would erase the repair.
  assert.equal(board.replay.aborted, 1);
  assert.equal(fs.readFileSync(path.join(sandbox.board, "issues", "LJ", "LJ-1.md"), "utf8"), repaired);
  assert.equal(
    (board.board.db.prepare("SELECT title FROM issues WHERE key='LJ-1'").get() as { title: string }).title,
    "사람이 고친 내용",
    "the index must reflect what is actually on disk",
  );
});

test("starts normally when the outbox is lost entirely", async (t) => {
  const sandbox = makeSandbox(t);
  const first = await sandbox.open();
  const { createIssue } = await import("../../src/domain/issue.ts");
  await createIssue(first, { project: "LJ", type: "story", title: "남아야 함" }, {
    id: "u", kind: "human",
  });
  await first.close();

  // D5: .local/ is not backed up. Losing it must cost nothing but the cache.
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(path.join(sandbox.board, ".local", `outbox.sqlite${suffix}`), { force: true });
  }

  const board = await sandbox.open();
  t.after(() => board.close());

  assert.equal(board.replay.replayed, 0);
  assert.equal(
    (board.board.db.prepare("SELECT title FROM issues WHERE key='LJ-1'").get() as { title: string }).title,
    "남아야 함",
  );
});

test("refuses domain writes until the replay has finished", async (t) => {
  const sandbox = makeSandbox(t);
  const board = await sandbox.open();
  t.after(() => board.close());

  const outbox = new Outbox(board.board.localDirectory);
  t.after(() => outbox.close());
  const { BoardWriter } = await import("../../src/storage/writer.ts");
  const fresh = new BoardWriter(board.board, outbox);

  await assert.rejects(
    () =>
      fresh.write({
        kind: "create", targetPath: "issues/LJ/LJ-9.md", contents: "---\nkey: LJ-9\n---\n\n",
        expectedHash: null, actorId: "u", actorKind: "human",
      }),
    (error: unknown) => {
      assert.ok(error instanceof WriteConflictError);
      assert.match(error.message, /replay/i);
      return true;
    },
  );
});

// ── append durability ───────────────────────────────────────────────────────

test("never leaves a truncated line in an append-only log", async (t) => {
  const sandbox = makeSandbox(t);

  for (const point of ["after_index", "after_event"] as CrashPoint[]) {
    cli(
      sandbox.repo,
      ["issue", "create", "--project", "LJ", "--type", "task", "--title", `append ${point}`],
      { LOCALJIRA_WRITE_CRASH_AT: point },
    );
    const board = await sandbox.open();
    await board.close();
  }

  const root = path.join(sandbox.board, "events");
  for (const day of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, day))) {
      const text = fs.readFileSync(path.join(root, day, file), "utf8");
      assert.equal(text.endsWith("\n"), true, "every record ends with its newline");
      for (const line of text.split("\n").filter((entry) => entry.trim() !== "")) {
        assert.doesNotThrow(() => JSON.parse(line), `truncated line: ${line}`);
      }
    }
  }
});
