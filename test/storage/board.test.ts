import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BootstrapError } from "../../src/bootstrap/execute.ts";
import {
  findIssue,
  indexStatus,
  listIssues,
  openBoard,
} from "../../src/storage/board.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

interface Sandbox {
  repo: string;
  board: string;
  issue(key: string, fields?: Record<string, string>, body?: string): void;
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

function makeSandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-board-")));
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

  const board = path.join(repo, ".localjira");
  return {
    repo,
    board,
    issue(key, fields = {}, body = "본문\n") {
      // Merged rather than appended: a second `status:` line would be a
      // duplicate key, which the parser rejects outright.
      const merged: Record<string, string> = {
        uid: `01J${key.replace(/\W/g, "").toUpperCase()}${"0".repeat(20)}`.slice(0, 26),
        key,
        type: "story",
        title: `${key} 제목`,
        status: "TODO",
        backlog_rank: `"0|hzzz${key.replace(/\D/g, "").padStart(2, "0")}:"`,
        ...fields,
      };
      const front = Object.entries(merged)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n");

      const file = path.join(board, "issues", "LJ", `${key}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\n${front}\n---\n${body}`);
    },
  };
}

test("refuses to open a board that was never initialised", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-none-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  git(repo, ["init", "--initial-branch=main"]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => openBoard(repo),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.code, "E_BOARD_NOT_INITIALIZED");
      return true;
    },
  );
});

test("builds the index on first open and reuses it afterwards", (t) => {
  const sandbox = makeSandbox(t);
  sandbox.issue("LJ-1");

  const first = openBoard(sandbox.repo);
  assert.equal(first.refresh.mode, "rebuilt");
  assert.equal(first.refresh.reason, "fresh");
  assert.equal(listIssues(first).length, 1);
  first.close();

  const second = openBoard(sandbox.repo);
  t.after(() => second.close());
  assert.equal(second.refresh.mode, "incremental");
  assert.equal(second.refresh.stats.hashed, 0, "nothing changed, so nothing is read");
});

test("picks up a file edited outside the tool", (t) => {
  const sandbox = makeSandbox(t);
  sandbox.issue("LJ-1");
  openBoard(sandbox.repo).close();

  // The editing workflow the product promises: change the file, run a command.
  sandbox.issue("LJ-1", { points: "5" });
  const board = openBoard(sandbox.repo);
  t.after(() => board.close());

  assert.equal(listIssues(board)[0].points, 5);
});

test("filters and orders the issue list", (t) => {
  const sandbox = makeSandbox(t);
  sandbox.issue("LJ-1", { status: "DONE", labels: "[core]" });
  sandbox.issue("LJ-2", { points: "3" });
  sandbox.issue("LJ-3");

  const board = openBoard(sandbox.repo);
  t.after(() => board.close());

  assert.deepEqual(listIssues(board).map((i) => i.key), ["LJ-1", "LJ-2", "LJ-3"]);
  assert.deepEqual(
    listIssues(board, { status: "todo" }).map((i) => i.key),
    ["LJ-2", "LJ-3"],
    "status matching is case-insensitive",
  );
  assert.deepEqual(listIssues(board, { limit: 1 }).map((i) => i.key), ["LJ-1"]);
  assert.deepEqual(listIssues(board, { project: "OTHER" }), []);
  assert.deepEqual(listIssues(board)[0].labels, ["core"]);
});

test("finds an issue by its current key and by a former key", (t) => {
  const sandbox = makeSandbox(t);
  sandbox.issue("LJ-7", { former_keys: "[LJ-3]" });

  const board = openBoard(sandbox.repo);
  t.after(() => board.close());

  const current = findIssue(board, "LJ-7");
  assert.ok(current && "issue" in current);
  assert.equal(current.issue.key, "LJ-7");
  assert.match(current.issue.etag, /^[0-9a-f]{64}$/);

  // A rekeyed issue stays reachable by the key someone still remembers (D3).
  const alias = findIssue(board, "LJ-3");
  assert.ok(alias && "issue" in alias);
  assert.equal(alias.issue.key, "LJ-7");

  assert.equal(findIssue(board, "LJ-404"), null);
});

test("reports ambiguity rather than guessing", (t) => {
  const sandbox = makeSandbox(t);
  // Two files claiming the same key: what an offline merge leaves behind.
  sandbox.issue("LJ-1");
  fs.writeFileSync(
    path.join(sandbox.board, "issues", "LJ", "LJ-1-other.md"),
    `---\nuid: 01JOTHER${"0".repeat(18)}\nkey: LJ-1\ntype: story\ntitle: 다른 이슈\nstatus: TODO\n---\n본문\n`,
  );

  const board = openBoard(sandbox.repo);
  t.after(() => board.close());

  const found = findIssue(board, "LJ-1");
  assert.ok(found && "ambiguous" in found);
  assert.equal(found.ambiguous.length, 2);
});

test("surfaces unindexable files in the status report", (t) => {
  const sandbox = makeSandbox(t);
  sandbox.issue("LJ-1");
  fs.writeFileSync(path.join(sandbox.board, "issues", "LJ", "LJ-9.md"), "no frontmatter\n");

  const board = openBoard(sandbox.repo);
  t.after(() => board.close());

  const status = indexStatus(board);
  assert.equal(status.counts.issues, 1);
  assert.equal(status.errors.length, 1);
  assert.equal(status.errors[0].reason, "frontmatter_missing");
  assert.match(status.boardId ?? "", /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

// ── CLI surface ─────────────────────────────────────────────────────────────

test("index status exits non-zero when a file cannot be indexed", (t) => {
  const sandbox = makeSandbox(t);
  sandbox.issue("LJ-1");

  assert.equal(cli(sandbox.repo, ["index", "status"]).status, 0);

  fs.writeFileSync(path.join(sandbox.board, "issues", "LJ", "LJ-9.md"), "broken\n");
  const broken = cli(sandbox.repo, ["index", "status"]);

  assert.equal(broken.status, 1, "a silent zero would hide the damage");
  assert.match(broken.stdout, /LJ-9\.md/);
  assert.match(broken.stdout, /frontmatter_missing/);
});

test("issue list renders a table and JSON", (t) => {
  const sandbox = makeSandbox(t);
  sandbox.issue("LJ-1", { labels: "[core]", points: "8" });
  sandbox.issue("LJ-2", { status: "DONE" });

  const table = cli(sandbox.repo, ["issue", "list"]);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /LJ-1/);
  assert.match(table.stdout, /2 issue\(s\)/);

  const json = cli(sandbox.repo, ["issue", "list", "--status", "DONE", "--json"]);
  const parsed = JSON.parse(json.stdout) as Array<{ key: string }>;
  assert.deepEqual(parsed.map((issue) => issue.key), ["LJ-2"]);
});

test("issue show reports a missing key without a stack trace", (t) => {
  const sandbox = makeSandbox(t);
  sandbox.issue("LJ-1");

  const found = cli(sandbox.repo, ["issue", "show", "LJ-1", "--json"]);
  assert.equal(found.status, 0, found.stderr);
  const issue = JSON.parse(found.stdout) as { key: string; resource: Record<string, unknown> };
  assert.equal(issue.key, "LJ-1");
  assert.equal(issue.resource.key, "LJ-1");

  const missing = cli(sandbox.repo, ["issue", "show", "LJ-404"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /E_ISSUE_NOT_FOUND/);
  assert.equal(missing.stderr.includes("at Object"), false);
});

test("index rebuild forces a full rebuild", (t) => {
  const sandbox = makeSandbox(t);
  sandbox.issue("LJ-1");
  openBoard(sandbox.repo).close();

  const rebuilt = cli(sandbox.repo, ["index", "rebuild", "--json"]);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  const status = JSON.parse(rebuilt.stdout) as { refresh: { mode: string; reason: string } };
  assert.equal(status.refresh.mode, "rebuilt");
  assert.equal(status.refresh.reason, "requested");
});

test("a rebuild leaves the working tree clean", (t) => {
  const sandbox = makeSandbox(t);
  sandbox.issue("LJ-1");
  git(sandbox.board, ["add", "-A"]);
  git(sandbox.board, ["commit", "-m", "add issue"]);

  cli(sandbox.repo, ["index", "rebuild"]);

  // The index lives under .local/, which the data branch ignores; a rebuild
  // must not show up as a change to the board.
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: sandbox.board,
    encoding: "utf8",
  });
  assert.equal(status.stdout.trim(), "");
});
