import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openIndex, indexPath, setMeta } from "../../src/storage/index-db.ts";
import { incrementalSync, rebuildIndex, scanBoard } from "../../src/storage/reindex.ts";

interface Board {
  root: string;
  local: string;
  write(relative: string, contents: string): string;
}

function makeBoard(t: { after: (fn: () => void) => void }): Board {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-idx-")));
  const local = path.join(root, ".local");
  fs.mkdirSync(local, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  return {
    root,
    local,
    write(relative, contents) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
      return target;
    },
  };
}

function issue(key: string, extra = "", body = "본문\n"): string {
  return `---\nuid: 01J${key.replace(/\W/g, "")}0000000000000000\nkey: ${key}\ntype: story\ntitle: ${key} title\nstatus: TODO\nbacklog_rank: "0|hzzzzz:"\n${extra}---\n${body}`;
}

function seed(board: Board): void {
  board.write("config.yaml", "schema_version: 1\nboard_id: 01JBOARD0000000000000000AA\ndefault_project: LJ\n");
  board.write("users.yaml", "schema_version: 1\nusers:\n  - id: u_admin\n    display_name: Admin\n    role: admin\n");
  board.write("projects/LJ.yaml", "schema_version: 1\nkey: LJ\nname: Local Jira\ntimezone: Asia/Seoul\nestimation_unit: story_points\n");
  board.write("issues/LJ/LJ-1.md", issue("LJ-1", "labels: [web, perf]\npoints: 3\n"));
  board.write("issues/LJ/LJ-2.md", issue("LJ-2", "sprint: LJ-S1\n"));
  board.write("sprints/LJ/LJ-S1.yaml", "schema_version: 1\nid: LJ-S1\nname: Sprint 1\nstatus: ACTIVE\ncapacity: 20\n");
}

function open(board: Board) {
  const opened = openIndex(board.local);
  return opened.db;
}

function rebuild(board: Board) {
  const { db, stats } = rebuildIndex(board.root, board.local, open(board));
  return { db, stats };
}

function snapshot(db: ReturnType<typeof open>): string {
  const issues = db
    .prepare("SELECT path, uid, key, status, resource_json, etag FROM issues ORDER BY path")
    .all();
  const labels = db.prepare("SELECT path, label FROM issue_labels ORDER BY path, label").all();
  const comments = db
    .prepare("SELECT comment_id, body, resolved, deleted FROM comments ORDER BY comment_id")
    .all();
  const sprints = db.prepare("SELECT id, status, capacity FROM sprints ORDER BY id").all();
  const projects = db.prepare("SELECT key, name, timezone FROM projects ORDER BY key").all();
  const events = db.prepare("SELECT event_id, at, verb FROM events ORDER BY at, event_id").all();
  const config = db.prepare("SELECT k, v FROM board_config ORDER BY k").all();
  const users = db.prepare("SELECT id, role FROM users ORDER BY id").all();

  return JSON.stringify({ issues, labels, comments, sprints, projects, events, config, users });
}

test("classifies and loads every SoT file kind", (t) => {
  const board = makeBoard(t);
  seed(board);
  board.write("comments/LJ-1/01JCOMMENT00000000000000A.md", "---\ncomment_id: 01JCOMMENT00000000000000A\nauthor_id: u_admin\nkind: question\n---\n질문입니다\n");
  board.write("runs/LJ/2026-07/01JRUN00000000000000000AA.json", JSON.stringify({ run_id: "01JRUN00000000000000000AA", agent_id: "a1", state: "DONE" }));
  board.write("events/2026-07-27/node-a.jsonl", JSON.stringify({ event_id: "01JEV1", at: "2026-07-27T01:00:00Z", verb: "issue.created" }) + "\n");

  const { db, stats } = rebuild(board);
  t.after(() => db.close());

  assert.equal(stats.failed, 0);
  const kinds = db.prepare("SELECT kind, COUNT(*) c FROM file_state GROUP BY kind").all() as Array<{ kind: string; c: number }>;
  const byKind = Object.fromEntries(kinds.map((row) => [row.kind, row.c]));

  assert.deepEqual(byKind, {
    config: 1, users: 1, project: 1, issue: 2, sprint: 1, comment: 1, run: 1, event: 1,
  });
  // config/users/projects must be tracked too, or "recover from files alone"
  // would quietly exclude the board's own settings.
  assert.equal(db.prepare("SELECT v FROM board_config WHERE k='board_id'").get()?.v, "01JBOARD0000000000000000AA");
  assert.equal(db.prepare("SELECT role FROM users WHERE id='u_admin'").get()?.role, "admin");
});

test("ignores files that are not board data", (t) => {
  const board = makeBoard(t);
  seed(board);
  board.write("README.md", "# notes\n");
  board.write("issues/LJ/LJ-1.md.bak", issue("LJ-1"));
  board.write(".local/index.sqlite-journal", "junk");

  const { db } = rebuild(board);
  t.after(() => db.close());

  const paths = (db.prepare("SELECT path FROM file_state").all() as Array<{ path: string }>).map((r) => r.path);
  assert.equal(paths.includes("README.md"), false);
  assert.equal(paths.includes("issues/LJ/LJ-1.md.bak"), false);
  assert.equal(paths.some((p) => p.startsWith(".local/")), false);
});

test("produces an identical index after the database is deleted", (t) => {
  const board = makeBoard(t);
  seed(board);
  board.write("comments/LJ-1/01JC1.md", "---\ncomment_id: 01JC1\nkind: question\n---\n첫 코멘트\n");
  board.write(
    "comments/LJ-1/01JC1.ops.jsonl",
    [
      JSON.stringify({ op_id: "01JOP1", op: "resolve" }),
      JSON.stringify({ op_id: "01JOP2", op: "unresolve" }),
    ].join("\n") + "\n",
  );

  const first = rebuild(board);
  const before = snapshot(first.db);
  first.db.close();

  fs.rmSync(indexPath(board.local), { force: true });
  const second = rebuild(board);
  t.after(() => second.db.close());

  // AC2: identical API-visible state, with only derived timing excluded.
  assert.equal(snapshot(second.db), before);
});

test("replays comment ops in op_id order", (t) => {
  const board = makeBoard(t);
  seed(board);
  board.write("comments/LJ-1/01JC1.md", "---\ncomment_id: 01JC1\nkind: question\n---\n원문\n");
  board.write(
    "comments/LJ-1/01JC1.ops.jsonl",
    // Written out of order on purpose: replay must sort, not trust file order.
    [
      JSON.stringify({ op_id: "01JOP2", op: "unresolve" }),
      JSON.stringify({ op_id: "01JOP1", op: "resolve" }),
    ].join("\n") + "\n",
  );

  const { db } = rebuild(board);
  t.after(() => db.close());

  const comment = db.prepare("SELECT resolved, body FROM comments WHERE comment_id='01JC1'").get() as { resolved: number; body: string };
  assert.equal(comment.resolved, 0, "resolve then unresolve leaves it unresolved");
  assert.equal(comment.body, "원문\n", "the original file is not rewritten by ops");
});

test("merges event files from several nodes", (t) => {
  const board = makeBoard(t);
  seed(board);
  board.write("events/2026-07-27/node-a.jsonl",
    [JSON.stringify({ event_id: "A2", at: "2026-07-27T02:00:00Z", verb: "b" }),
     JSON.stringify({ event_id: "A1", at: "2026-07-27T00:00:00Z", verb: "a" })].join("\n") + "\n");
  board.write("events/2026-07-27/node-b.jsonl",
    JSON.stringify({ event_id: "B1", at: "2026-07-27T01:00:00Z", verb: "c" }) + "\n");

  const { db } = rebuild(board);
  t.after(() => db.close());

  const order = (db.prepare("SELECT event_id FROM events ORDER BY at, event_id").all() as Array<{ event_id: string }>)
    .map((row) => row.event_id);
  assert.deepEqual(order, ["A1", "B1", "A2"]);
});

test("records a parse failure without aborting the rebuild", (t) => {
  const board = makeBoard(t);
  seed(board);
  board.write("issues/LJ/LJ-9.md", "no frontmatter at all\n");

  const { db, stats } = rebuild(board);
  t.after(() => db.close());

  assert.equal(stats.failed, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM issues").get()?.c, 2, "healthy issues still load");
  const error = db.prepare("SELECT reason FROM index_errors WHERE path='issues/LJ/LJ-9.md'").get() as { reason: string };
  assert.equal(error.reason, "frontmatter_missing");
});

test("keeps unknown keys and does not parse body headings", (t) => {
  const board = makeBoard(t);
  seed(board);
  board.write(
    "issues/LJ/LJ-3.md",
    issue("LJ-3", "somethingNew: kept\n", "## 코멘트\n본문 안의 제목입니다\n"),
  );

  const { db } = rebuild(board);
  t.after(() => db.close());

  const row = db.prepare("SELECT resource_json FROM issues WHERE key='LJ-3'").get() as { resource_json: string };
  const resource = JSON.parse(row.resource_json) as Record<string, unknown>;

  assert.equal(resource.somethingNew, "kept");
  assert.equal(resource.body, "## 코멘트\n본문 안의 제목입니다\n");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM comments").get()?.c, 0, "a body heading is not a comment");
});

test("does not touch domain files while rebuilding", (t) => {
  const board = makeBoard(t);
  seed(board);
  const before = new Map(
    scanBoard(board.root).map((file) => [file.identity.path, fs.readFileSync(file.absolutePath).toString("utf8")]),
  );

  const { db } = rebuild(board);
  t.after(() => db.close());

  for (const [relative, contents] of before) {
    assert.equal(fs.readFileSync(path.join(board.root, relative), "utf8"), contents, `${relative} was modified`);
  }
});

test("discards an index whose schema version moved on", (t) => {
  const board = makeBoard(t);
  seed(board);
  const first = rebuild(board);
  setMeta(first.db, "schema_version", "999");
  first.db.close();

  const reopened = openIndex(board.local);
  t.after(() => reopened.db.close());

  assert.equal(reopened.needsRebuild, true);
  assert.equal(reopened.reason, "schema_version");
  assert.equal(reopened.db.prepare("SELECT COUNT(*) c FROM issues").get()?.c, 0);
});

test("rebuilds rather than repairing a corrupt index", (t) => {
  const board = makeBoard(t);
  seed(board);
  rebuild(board).db.close();
  fs.writeFileSync(indexPath(board.local), "this is not a database");

  const reopened = openIndex(board.local);
  t.after(() => reopened.db.close());

  assert.equal(reopened.needsRebuild, true);
});

test("reads nothing when no file changed", (t) => {
  const board = makeBoard(t);
  seed(board);
  const { db } = rebuild(board);
  t.after(() => db.close());

  const stats = incrementalSync(board.root, db);

  // Every file matched on (mtime, size), so none was opened or hashed.
  assert.equal(stats.hashed, 0);
  assert.equal(stats.parsed, 0);
  assert.equal(stats.removed, 0);
});

test("hashes and reparses only the file that changed", (t) => {
  const board = makeBoard(t);
  seed(board);
  const { db } = rebuild(board);
  t.after(() => db.close());
  const beforeEtag = db.prepare("SELECT etag FROM issues WHERE key='LJ-1'").get() as { etag: string };

  board.write("issues/LJ/LJ-1.md", issue("LJ-1", "labels: [web, perf]\npoints: 5\n"));
  const stats = incrementalSync(board.root, db);

  assert.equal(stats.hashed, 1);
  assert.equal(stats.parsed, 1);
  assert.ok(stats.durationMs < 100, `incremental sync took ${stats.durationMs}ms`);

  const after = db.prepare("SELECT etag, points FROM issues WHERE key='LJ-1'").get() as { etag: string; points: number };
  assert.equal(after.points, 5);
  assert.notEqual(after.etag, beforeEtag.etag);
});

test("refreshes the stat cache when metadata moves but content does not", (t) => {
  const board = makeBoard(t);
  seed(board);
  const { db } = rebuild(board);
  t.after(() => db.close());

  const target = path.join(board.root, "issues/LJ/LJ-1.md");
  const contents = fs.readFileSync(target);
  fs.writeFileSync(target, contents);

  const stats = incrementalSync(board.root, db);
  assert.equal(stats.hashed, 1, "the changed mtime forces one hash");
  assert.equal(stats.parsed, 0, "identical content is not reparsed");
});

test("tombstones an issue whose file disappeared", (t) => {
  const board = makeBoard(t);
  seed(board);
  const { db } = rebuild(board);
  t.after(() => db.close());

  fs.rmSync(path.join(board.root, "issues/LJ/LJ-2.md"));
  const stats = incrementalSync(board.root, db);

  assert.equal(stats.removed, 1);
  // Gone from the board, still in the index. Dropping the row would take the
  // history with it and leave a later lookup with nothing to say (r08c).
  assert.equal(db.prepare("SELECT COUNT(*) c FROM issues WHERE state='OK'").get()?.c, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM issues WHERE state='PENDING_DELETE'").get()?.c,
    1,
  );
  // The file tracking row does go: the file really is not there.
  assert.equal(db.prepare("SELECT COUNT(*) c FROM file_state WHERE path LIKE 'issues/%'").get()?.c, 1);
});

test("leaves no residue when an issue is edited", (t) => {
  const board = makeBoard(t);
  seed(board);
  const { db } = rebuild(board);
  t.after(() => db.close());

  // Drop one label and both were previously indexed; the stale row must go.
  board.write("issues/LJ/LJ-1.md", issue("LJ-1", "labels: [web]\n"));
  incrementalSync(board.root, db);

  const labels = (db.prepare("SELECT label FROM issue_labels ORDER BY label").all() as Array<{ label: string }>)
    .map((row) => row.label);
  assert.deepEqual(labels, ["web"]);

  // Exactly one FTS row per issue: a reload must delete the old row, not add
  // a second one that would double every future search hit.
  const uid = (db.prepare("SELECT uid FROM issues WHERE key='LJ-1'").get() as { uid: string }).uid;
  assert.equal(db.prepare("SELECT COUNT(*) c FROM issues_fts WHERE uid = ?").get(uid)?.c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM issues_fts").get()?.c, 2);
});

test("matches an issue key through FTS when it is quoted", (t) => {
  const board = makeBoard(t);
  seed(board);
  const { db } = rebuild(board);
  t.after(() => db.close());

  // A key contains a hyphen, which FTS5 reads as NOT unless the term is
  // quoted. R4 has to quote user input; recorded here so it is not discovered
  // as a search bug later.
  const quoted = db.prepare("SELECT COUNT(*) c FROM issues_fts WHERE issues_fts MATCH ?").get('"LJ-1"');
  assert.equal(quoted?.c, 1);
  assert.throws(
    () => db.prepare("SELECT COUNT(*) c FROM issues_fts WHERE issues_fts MATCH ?").get("LJ-1"),
    /no such column|SQL logic error/,
  );
});

test("holds duplicate keys and duplicate uids instead of rejecting them", (t) => {
  const board = makeBoard(t);
  seed(board);
  // What an offline merge produces: two files claiming the same key and uid.
  board.write("issues/LJ/LJ-dup.md", issue("LJ-1"));

  const { db, stats } = rebuild(board);
  t.after(() => db.close());

  assert.equal(stats.failed, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM issues WHERE key='LJ-1'").get()?.c,
    2,
    "both sides must survive so rekeying can choose between them",
  );
});

test("rebuilds a 5,000 issue board within the budget", { timeout: 120_000 }, (t) => {
  const board = makeBoard(t);
  seed(board);
  for (let index = 0; index < 5_000; index += 1) {
    const key = `LJ-${1000 + index}`;
    board.write(
      `issues/LJ/${key}.md`,
      issue(key, "labels: [bulk]\npoints: 3\n", `본문 ${index}\n`.repeat(8)),
    );
  }

  const { db, stats } = rebuild(board);
  t.after(() => db.close());

  assert.equal(db.prepare("SELECT COUNT(*) c FROM issues").get()?.c, 5_002);
  assert.ok(stats.durationMs <= 10_000, `full rebuild took ${stats.durationMs}ms (budget 10s)`);

  const unchanged = incrementalSync(board.root, db);
  assert.equal(unchanged.hashed, 0, "an unchanged restart must not read any file");
});
