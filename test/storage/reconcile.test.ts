import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../fixtures/cli-token.ts";

import { openBoardForWriting, type WritableBoard } from "../../src/storage/board.ts";
import { fullReconcile, findTombstone, DELETE_GRACE_MS } from "../../src/storage/reconcile.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

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

function cli(cwd: string, args: string[]) {
  // r13c: `issue create` needs a token, which runCli mints for this board.
  return runCli(cwd, args);
}

function makeSandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-reconcile-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "r@example.com"]);
  git(repo, ["config", "user.name", "Reconcile"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
  cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]);

  return {
    repo,
    board: path.join(repo, ".localjira"),
    open: () => openBoardForWriting(repo),
  };
}

function createIssue(sandbox: Sandbox, title: string): string {
  const result = cli(sandbox.repo, [
    "issue", "create", "--project", "LJ", "--type", "task", "--title", title, "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  return (JSON.parse(result.stdout) as { key: string }).key;
}

function issueFile(sandbox: Sandbox, key: string): string {
  return path.join(sandbox.board, "issues", "LJ", `${key}.md`);
}

test("a deleted file becomes a tombstone rather than a missing row", async (t) => {
  const sandbox = makeSandbox(t);
  const key = createIssue(sandbox, "삭제될 이슈");

  const board = await sandbox.open();
  t.after(() => board.close());

  fs.rmSync(issueFile(sandbox, key));
  const report = fullReconcile(sandbox.board, board.board.db, { reason: "manual" });

  assert.equal(report.tombstoned.length, 1);
  assert.equal(report.tombstoned[0].key, key);
  assert.equal(report.confirmed.length, 0, "the grace period has not run out yet");

  // Gone from the board…
  const listed = board.board.db
    .prepare("SELECT COUNT(*) c FROM issues WHERE state = 'OK'")
    .get() as { c: number };
  assert.equal(listed.c, 0);

  // …but not gone from the index. Deleting the row would take the history with
  // it, and the tombstone is what a 404 reads to say where the file used to be.
  const tombstone = findTombstone(board.board.db, key);
  assert.equal(tombstone?.path, `issues/LJ/${key}.md`);
  assert.equal(tombstone?.pending, true);
});

test("a file that reappears elsewhere is a move, not a delete", async (t) => {
  const sandbox = makeSandbox(t);
  const key = createIssue(sandbox, "이동할 이슈");

  const board = await sandbox.open();
  t.after(() => board.close());

  const from = issueFile(sandbox, key);
  const uid = (
    board.board.db.prepare("SELECT uid FROM issues WHERE key = ?").get(key) as { uid: string }
  ).uid;

  // Same uid under a different key — the layout puts an issue at
  // issues/<project>/<key>.md exactly, so a move *is* a rekey (D3).
  const to = issueFile(sandbox, "LJ-7");
  fs.writeFileSync(to, fs.readFileSync(from, "utf8").replace(/^key: .*$/m, "key: LJ-7"));
  fs.rmSync(from);

  const report = fullReconcile(sandbox.board, board.board.db, { reason: "manual" });

  assert.equal(report.tombstoned.length, 0, "a move must not be reported as a deletion");
  assert.equal(report.renamed.length, 1);
  assert.equal(report.renamed[0].uid, uid);
  assert.equal(report.renamed[0].to, "issues/LJ/LJ-7.md");

  // The entity survived as itself: same uid, still visible, one row only.
  const rows = board.board.db
    .prepare("SELECT path, uid, state FROM issues WHERE uid = ?")
    .all(uid) as Array<{ path: string; state: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "OK");
  assert.equal(rows[0].path, "issues/LJ/LJ-7.md");
});

test("a tombstone is cancelled when the file returns inside the grace period", async (t) => {
  const sandbox = makeSandbox(t);
  const key = createIssue(sandbox, "잠깐 사라질 이슈");

  const board = await sandbox.open();
  t.after(() => board.close());

  const original = issueFile(sandbox, key);
  const contents = fs.readFileSync(original);
  const uid = (
    board.board.db.prepare("SELECT uid FROM issues WHERE key = ?").get(key) as { uid: string }
  ).uid;

  // Delete now, reappear elsewhere a few seconds later — the shape of a
  // checkout that removes a tree before writing the new one.
  fs.rmSync(original);
  const first = fullReconcile(sandbox.board, board.board.db, { reason: "git_head_change" });
  assert.equal(first.tombstoned.length, 1);

  fs.writeFileSync(
    issueFile(sandbox, "LJ-8"),
    contents.toString("utf8").replace(/^key: .*$/m, "key: LJ-8"),
  );

  const second = fullReconcile(sandbox.board, board.board.db, {
    reason: "git_head_change",
    now: Date.now() + 5_000,
  });

  assert.equal(second.renamed.length, 1, "the return inside grace is a move");
  assert.equal(second.confirmed.length, 0, "and must not confirm the deletion");

  // Spread each row: node:sqlite hands back null-prototype objects, which
  // deepEqual refuses to match against an object literal however equal the
  // contents are.
  const rows = (
    board.board.db
      .prepare("SELECT path, state FROM issues WHERE uid = ?")
      .all(uid) as Array<{ path: string; state: string }>
  ).map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ path: "issues/LJ/LJ-8.md", state: "OK" }]);
});

test("a tombstone becomes a real deletion once the grace period runs out", async (t) => {
  const sandbox = makeSandbox(t);
  const key = createIssue(sandbox, "정말 삭제될 이슈");

  const board = await sandbox.open();
  t.after(() => board.close());

  fs.rmSync(issueFile(sandbox, key));
  fullReconcile(sandbox.board, board.board.db, { reason: "manual" });

  const later = Date.now() + DELETE_GRACE_MS + 1_000;
  const report = fullReconcile(sandbox.board, board.board.db, { reason: "manual", now: later });

  assert.equal(report.confirmed.length, 1);
  assert.equal(report.confirmed[0].key, key);

  // Confirmed, and reported once. A later run has nothing new to say.
  const again = fullReconcile(sandbox.board, board.board.db, { reason: "manual", now: later });
  assert.equal(again.confirmed.length, 0, "a confirmed deletion is not re-announced");

  const tombstone = findTombstone(board.board.db, key);
  assert.equal(tombstone?.pending, false, "no longer waiting for the file to come back");
});

test("reconciling twice changes nothing the second time", async (t) => {
  const sandbox = makeSandbox(t);
  createIssue(sandbox, "첫째");
  const second = createIssue(sandbox, "둘째");

  const board = await sandbox.open();
  t.after(() => board.close());

  fs.rmSync(issueFile(sandbox, second));
  const first = fullReconcile(sandbox.board, board.board.db, { reason: "startup" });
  const repeat = fullReconcile(sandbox.board, board.board.db, { reason: "startup" });

  assert.equal(first.tombstoned.length, 1);
  assert.equal(repeat.tombstoned.length, 0, "the tombstone is not created twice");
  assert.deepEqual(repeat.changed, [], "nothing on disk changed, so nothing reparsed");
});

test("an interrupted reconcile leaves the index as a complete one would", async (t) => {
  const sandbox = makeSandbox(t);
  const keys = [createIssue(sandbox, "하나"), createIssue(sandbox, "둘"), createIssue(sandbox, "셋")];

  const board = await sandbox.open();
  t.after(() => board.close());

  // Three changes at once: one edited, one deleted, one added — a pull.
  const edited = issueFile(sandbox, keys[0]);
  fs.writeFileSync(edited, fs.readFileSync(edited, "utf8").replace(/^title: .*$/m, "title: 수정됨"));
  fs.rmSync(issueFile(sandbox, keys[1]));
  fs.writeFileSync(
    path.join(sandbox.board, "issues", "LJ", "LJ-99.md"),
    `---\nuid: 01JRECON${"0".repeat(18)}\nkey: LJ-99\ntype: task\ntitle: 새로 들어온 것\nstatus: BACKLOG\n---\n\n`,
  );

  const interrupted = fullReconcile(sandbox.board, board.board.db, { reason: "git_head_change" });
  const snapshot = (): unknown =>
    board.board.db
      .prepare("SELECT path, uid, key, title, state FROM issues ORDER BY path")
      .all();
  const afterFirst = JSON.stringify(snapshot());

  // Running it again from scratch must not drift.
  fullReconcile(sandbox.board, board.board.db, { reason: "git_head_change" });
  assert.equal(JSON.stringify(snapshot()), afterFirst, "reconciliation is idempotent");

  assert.equal(interrupted.tombstoned.length, 1);
  assert.equal(interrupted.changed.includes("issues/LJ/LJ-99.md"), true);
  assert.equal(interrupted.changed.includes(`issues/LJ/${keys[0]}.md`), true);
});

test("re-hashes every file rather than trusting mtime and size", async (t) => {
  const sandbox = makeSandbox(t);
  const key = createIssue(sandbox, "체크섬 대상");

  const board = await sandbox.open();
  t.after(() => board.close());

  const file = issueFile(sandbox, key);
  const before = fs.statSync(file);
  const original = fs.readFileSync(file, "utf8");

  // Same byte count, same timestamps, different content — what a checkout can
  // leave behind and what the incremental shortcut would sail straight past.
  const swapped = original.replace(/^title: .*$/m, `title: ${"X".repeat("체크섬 대상".length)}`);
  assert.notEqual(swapped, original);
  fs.writeFileSync(file, swapped);
  fs.utimesSync(file, before.atime, before.mtime);

  const report = fullReconcile(sandbox.board, board.board.db, { reason: "git_head_change" });
  assert.equal(report.changed.includes(`issues/LJ/${key}.md`), true, "the edit was noticed");

  const row = board.board.db
    .prepare("SELECT title FROM issues WHERE key = ?")
    .get(key) as { title: string };
  assert.equal(row.title, "X".repeat("체크섬 대상".length));
});
