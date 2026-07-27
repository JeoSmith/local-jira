import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectBootstrap } from "../../src/bootstrap/doctor.ts";

test("reports a non-repository without mutating it", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "localjira-not-git-"));
  const report = inspectBootstrap(directory);

  assert.equal(report.status, "E_NOT_GIT_REPOSITORY");
  assert.equal(report.ok, false);
});

test("reports a fresh primary worktree as uninitialized", () => {
  const repository = createRepository();
  const report = inspectBootstrap(repository);

  assert.equal(report.status, "UNINITIALIZED");
  assert.equal(report.repoRoot, realpathSync.native(repository));
  assert.equal(report.localBranchExists, false);
});

test("rejects initialization diagnostics from a linked worktree", () => {
  const repository = createRepository();
  const linked = `${repository}-linked`;
  git(repository, ["worktree", "add", "--detach", linked, "HEAD"]);

  const report = inspectBootstrap(linked);

  assert.equal(report.status, "E_NOT_PRIMARY_WORKTREE");
  assert.equal(report.repoRoot, realpathSync.native(repository));
});

test("reports a complete data worktree as ready", () => {
  const repository = createRepository();
  const board = path.join(repository, ".localjira");
  const temporaryBoard = `${repository}-board`;

  git(repository, ["worktree", "add", "--detach", temporaryBoard, "HEAD"]);
  git(temporaryBoard, ["switch", "--orphan", "localjira/data"]);

  writeFileSync(path.join(temporaryBoard, ".gitattributes"), "* text=auto\n");
  writeFileSync(path.join(temporaryBoard, ".gitignore"), "/.local/\n");
  writeFileSync(path.join(temporaryBoard, "config.yaml"), "schema_version: 1\n");
  writeFileSync(path.join(temporaryBoard, "users.yaml"), "schema_version: 1\nusers: []\n");
  mkdirSync(path.join(temporaryBoard, "projects"));
  writeFileSync(path.join(temporaryBoard, "projects", "LJ.yaml"), "key: LJ\n");
  git(temporaryBoard, ["add", "."]);
  git(temporaryBoard, ["commit", "-m", "initialize board"]);
  git(repository, ["worktree", "move", temporaryBoard, board]);
  writeFileSync(path.join(repository, ".gitignore"), "/.localjira/\n");

  const report = inspectBootstrap(repository);

  assert.equal(report.status, "READY");
  assert.equal(report.ok, true);
  assert.equal(report.boardWorktree?.branch, "refs/heads/localjira/data");
});

test("preserves and reports an occupied board path", () => {
  const repository = createRepository();
  const board = path.join(repository, ".localjira");
  mkdirSync(board);
  writeFileSync(path.join(board, "keep.txt"), "user data\n");

  const report = inspectBootstrap(repository);

  assert.equal(report.status, "E_BOARD_PATH_OCCUPIED");
  assert.equal(report.ok, false);
});

function createRepository(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "localjira-doctor-"));
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.name", "Local Jira Test"]);
  git(directory, ["config", "user.email", "localjira-test@example.invalid"]);
  git(directory, ["commit", "--allow-empty", "-q", "-m", "initial"]);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
