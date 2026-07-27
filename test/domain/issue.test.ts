import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createIssue, IssueError, timestamp } from "../../src/domain/issue.ts";
import { findIssue, listIssues, openBoard, type BoardHandle } from "../../src/storage/board.ts";
import { parseMarkdownResource } from "../../src/storage/resource.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const ACTOR = { id: "u_local", kind: "human" } as const;

interface Sandbox {
  repo: string;
  board: string;
  open(): BoardHandle;
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-issue-")));
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

  // init already made the structural commit, so the board tree starts clean.
  const board = path.join(repo, ".localjira");

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  return { repo, board, open: () => openBoard(repo) };
}

test("creates one markdown file and returns the issued key", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  const issue = createIssue(
    board,
    { project: "LJ", type: "story", title: "백로그 리스트 가상 스크롤" },
    ACTOR,
  );

  assert.equal(issue.key, "LJ-1");
  assert.match(issue.uid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(issue.path, "issues/LJ/LJ-1.md");
  assert.equal(fs.existsSync(path.join(sandbox.board, "issues/LJ/LJ-1.md")), true);
  assert.match(issue.etag, /^[0-9a-f]{64}$/);
});

test("leaves exactly one new file in the working tree", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  createIssue(board, { project: "LJ", type: "story", title: "제목" }, ACTOR);

  // -uall so git lists files rather than collapsing the new directory. AC1
  // is about the index, outbox and runtime state staying out of the tree.
  const status = git(sandbox.board, ["status", "--porcelain", "-uall"])
    .split("\n")
    .filter(Boolean);

  assert.deepEqual(status, ["?? issues/LJ/LJ-1.md"]);
});

test("writes the frontmatter contract", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  createIssue(
    board,
    {
      project: "LJ", type: "story", title: "제목",
      points: 3, labels: ["web", "perf"], assignee: "u_someone",
      acceptance: [{ text: "첫 번째" }, { text: "두 번째", done: true }],
    },
    ACTOR,
  );

  const parsed = parseMarkdownResource(
    fs.readFileSync(path.join(sandbox.board, "issues/LJ/LJ-1.md")),
  );
  const front = parsed.frontmatter as Record<string, unknown>;

  assert.equal(front.key, "LJ-1");
  assert.equal(front.type, "story");
  assert.equal(front.status, "BACKLOG");
  assert.equal(front.schema_version, 1);
  assert.equal(front.created_by_kind, "human");
  assert.deepEqual(front.former_keys, []);
  assert.deepEqual(front.labels, ["perf", "web"], "labels are normalised and sorted");
  assert.deepEqual(front.acceptance, [
    { id: "ac1", text: "첫 번째", done: false },
    { id: "ac2", text: "두 번째", done: true },
  ]);
  // Timestamps carry the project offset so a local day boundary is readable.
  assert.match(String(front.created_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
  assert.equal(front.created_at, front.updated_at);
});

test("puts the description in the body, not in a heading", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  createIssue(
    board,
    {
      project: "LJ", type: "story", title: "제목",
      description: "## 코멘트\n본문에 heading이 있어도 구분자가 아니다.",
    },
    ACTOR,
  );

  const raw = fs.readFileSync(path.join(sandbox.board, "issues/LJ/LJ-1.md"), "utf8");
  const parsed = parseMarkdownResource(Buffer.from(raw, "utf8"));

  assert.equal(parsed.body, "## 코멘트\n본문에 heading이 있어도 구분자가 아니다.\n");
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed.frontmatter, "description"),
    false,
    "the description is the body, not a frontmatter field",
  );
});

test("always starts an issue in BACKLOG", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  const issue = createIssue(board, { project: "LJ", type: "story", title: "제목" }, ACTOR);
  assert.equal(issue.status, "BACKLOG");

  // S1-D2: transitions are the only way to change state, so creation may not
  // pick a different starting point.
  assert.throws(
    () => createIssue(board, { project: "LJ", type: "story", title: "제목", status: "TODO" }, ACTOR),
    (error: unknown) => {
      assert.ok(error instanceof IssueError);
      assert.equal(error.code, "E_STATUS_NOT_ALLOWED");
      return true;
    },
  );
});

test("allocates keys in sequence per project", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  const keys = ["a", "b", "c"].map(
    (title) => createIssue(board, { project: "LJ", type: "task", title }, ACTOR).key,
  );
  assert.deepEqual(keys, ["LJ-1", "LJ-2", "LJ-3"]);
});

test("never reissues a number that a former key still holds", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  createIssue(board, { project: "LJ", type: "task", title: "one" }, ACTOR);

  // Stand in for a rekeyed issue: LJ-9 was released and must stay reserved,
  // because a commit trailer may still point at it.
  fs.writeFileSync(
    path.join(sandbox.board, "issues/LJ/LJ-20.md"),
    `---\nuid: 01JOTHER${"0".repeat(18)}\nkey: LJ-20\nformer_keys: [LJ-9]\ntype: task\ntitle: rekeyed\nstatus: BACKLOG\n---\n\n`,
  );
  const reopened = openBoard(sandbox.repo);
  t.after(() => reopened.close());

  const next = createIssue(reopened, { project: "LJ", type: "task", title: "two" }, ACTOR);
  assert.equal(next.key, "LJ-21", "the highest number ever used wins, not the highest live one");
});

test("rejects input it cannot store faithfully", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  const codes: string[] = [];
  for (const input of [
    { project: "LJ", type: "epicc", title: "x" },
    { project: "NOPE", type: "story", title: "x" },
    { project: "LJ", type: "story", title: "   " },
    { project: "LJ", type: "story", title: "x", points: 999 },
    { project: "LJ", type: "story", title: "x", points: 1.5 },
    { project: "LJ", type: "story", title: "x", labels: ["has space"] },
  ]) {
    try {
      createIssue(board, input, ACTOR);
      codes.push("(accepted)");
    } catch (error) {
      codes.push(error instanceof IssueError ? error.code : "(other)");
    }
  }

  assert.deepEqual(codes, [
    "E_INVALID_TYPE",
    "E_UNKNOWN_PROJECT",
    "E_INVALID_TITLE",
    "E_INVALID_POINTS",
    "E_INVALID_POINTS",
    "E_INVALID_LABEL",
  ]);
  assert.equal(listIssues(board).length, 0, "no file may be written for a rejected request");
});

test("keeps null points distinct from zero", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  const unestimated = createIssue(board, { project: "LJ", type: "task", title: "a" }, ACTOR);
  const zero = createIssue(board, { project: "LJ", type: "task", title: "b", points: 0 }, ACTOR);

  // The burndown excludes unestimated issues and counts zero-point ones (D8).
  assert.equal(unestimated.points, null);
  assert.equal(zero.points, 0);
  const raw = fs.readFileSync(path.join(sandbox.board, "issues/LJ/LJ-1.md"), "utf8");
  assert.equal(raw.includes("points:"), false, "unestimated omits the key entirely");
});

test("reads back through key and uid", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  const created = createIssue(
    board,
    { project: "LJ", type: "story", title: "제목", description: "설명" },
    ACTOR,
  );

  const byKey = findIssue(board, created.key);
  assert.ok(byKey && "issue" in byKey);
  assert.equal(byKey.issue.uid, created.uid);
  assert.equal(byKey.issue.etag, created.etag);
  assert.equal(
    (byKey.issue.resource as Record<string, unknown>).body,
    "설명\n",
    "the round trip returns the same body",
  );

  assert.equal(findIssue(board, "LJ-9999"), null);
});

test("preserves a hand-edited unknown key across a read", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  const created = createIssue(board, { project: "LJ", type: "story", title: "제목" }, ACTOR);
  const file = path.join(sandbox.board, created.path);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("schema_version: 1", "schema_version: 1\nmyOwnField: 유지"),
  );

  const reopened = openBoard(sandbox.repo);
  t.after(() => reopened.close());
  const found = findIssue(reopened, created.key);

  assert.ok(found && "issue" in found);
  assert.equal((found.issue.resource as Record<string, unknown>).myOwnField, "유지");
  assert.match(fs.readFileSync(file, "utf8"), /^myOwnField: 유지$/m);
});

test("formats a timestamp in the project timezone", () => {
  const instant = new Date("2026-07-27T15:30:00Z");

  assert.equal(timestamp("Asia/Seoul", instant), "2026-07-28T00:30:00+09:00");
  assert.equal(timestamp("UTC", instant), "2026-07-27T15:30:00Z");
  assert.equal(timestamp(null, instant), "2026-07-27T15:30:00Z");
});

test("creates an issue through the CLI", (t) => {
  const sandbox = makeSandbox(t);

  const created = cli(sandbox.repo, [
    "issue", "create", "--project", "LJ", "--type", "story",
    "--title", "CLI로 만든 이슈", "--points", "5",
    "--label", "web", "--label", "perf",
    "--acceptance", "첫째", "--acceptance", "둘째",
    "--json",
  ]);
  assert.equal(created.status, 0, created.stderr);

  const issue = JSON.parse(created.stdout) as { key: string; labels: string[]; points: number };
  assert.equal(issue.key, "LJ-1");
  assert.equal(issue.points, 5);
  assert.deepEqual(issue.labels, ["perf", "web"]);

  const listed = cli(sandbox.repo, ["issue", "list"]);
  assert.match(listed.stdout, /LJ-1 +BACKLOG/);

  const rejected = cli(sandbox.repo, [
    "issue", "create", "--project", "LJ", "--type", "nope", "--title", "x",
  ]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /E_INVALID_TYPE/);
  assert.match(rejected.stderr, /epic, story, task, bug, spike, subtask/);
});
