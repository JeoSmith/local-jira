import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMMENT_KINDS } from "../../src/domain/comment.ts";
import { startServer, type RunningServer } from "../../src/server/http.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

interface Session {
  server: RunningServer;
  repo: string;
  board: string;
  local: string;
  admin: string;
  member: string;
  bot: string;
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
  options: { body?: unknown; cookie?: string; bearer?: string; etag?: string; key?: string } = {},
): Promise<Result> {
  const response = await fetch(`${s.server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
      ...(options.etag ? { "if-match": options.etag } : {}),
      ...(options.key ? { "idempotency-key": options.key } : {}),
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

async function signIn(server: RunningServer, id: string): Promise<string> {
  const response = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, password: PASSWORD }),
  });
  assert.equal(response.status, 200, id);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

async function session(t: {
  after: (fn: () => void | Promise<void>) => void;
}): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-cmt-")));
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
  cli(repo, [
    "admin", "create", "--id", "dev", "--name", "개발자", "--password", PASSWORD,
    "--role", "member",
  ]);
  cli(repo, [
    "admin", "create", "--id", "bot", "--name", "에이전트", "--password", PASSWORD,
    "--role", "agent",
  ]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const server = await startServer({ cwd: repo, port: 0, watch: false });
  t.after(() => server.close());

  const partial: Session = {
    server, repo,
    board: path.join(repo, ".localjira"),
    local: path.join(repo, ".localjira", ".local"),
    admin: await signIn(server, "root"),
    member: await signIn(server, "dev"),
    bot: "",
  };
  const issued = await call(partial, "POST", "/tokens", {
    cookie: partial.admin, body: { user: "bot" },
  });
  partial.bot = issued.json.token as unknown as string;
  return partial;
}

async function anIssue(s: Session, title = "이야기할 일"): Promise<string> {
  const created = await call(s, "POST", "/issues", {
    cookie: s.admin, body: { project: "LJ", type: "task", title },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.key as unknown as string;
}

async function comment(
  s: Session,
  issue: string,
  body: string,
  kind?: string,
  who: "admin" | "member" | "bot" = "admin",
): Promise<string> {
  const options = who === "bot" ? { bearer: s.bot } : { cookie: s[who] };
  const created = await call(s, "POST", `/issues/${issue}/comments`, {
    ...options, body: { body, ...(kind === undefined ? {} : { kind }) },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.comment_id as unknown as string;
}

function commentFiles(s: Session, issue: string): string[] {
  const directory = path.join(s.board, "comments", issue);
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

// ── the model ───────────────────────────────────────────────────────────────

test("a comment is one file, with the four kinds and nothing else", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);

  assert.deepEqual(
    [...COMMENT_KINDS],
    ["general", "question", "decision", "review_request"],
  );

  const id = await comment(s, key, "이 부분 확인 부탁드립니다", "question");
  const listed = await call(s, "GET", `/issues/${key}/comments`, { cookie: s.admin });
  const [stored] = listed.json.comments as unknown as Array<Record<string, unknown>>;

  assert.equal(stored.comment_id, id);
  assert.equal(stored.kind, "question");
  assert.equal(stored.author_id, "root");
  assert.equal(stored.author_display_name, "루트");
  assert.equal(stored.actor_kind, "human");
  assert.equal(stored.resolved, false);
  assert.match(String(stored.created_at), /^\d{4}-\d{2}-\d{2}T/);

  // §5.3, AC1: one comment is one file, and git sees exactly that one.
  assert.deepEqual(commentFiles(s, key), [`${id}.md`]);

  const rejected = await call(s, "POST", `/issues/${key}/comments`, {
    cookie: s.admin, body: { body: "x", kind: "shout" },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.error?.code, "E_INVALID_COMMENT_KIND");
});

test("no kind means general, which is the one that gates nothing", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const id = await comment(s, key, "고생하셨습니다");

  // S4-D1: a gate that closes because somebody forgot a field is a gate people
  // learn to route around by not commenting.
  const listed = await call(s, "GET", `/issues/${key}/comments`, { cookie: s.admin });
  const [stored] = listed.json.comments as unknown as Array<Record<string, unknown>>;
  assert.equal(stored.comment_id, id);
  assert.equal(stored.kind, "general");
});

test("resolving never touches the original", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const id = await comment(s, key, "질문 있습니다", "question");

  const original = fs.readFileSync(path.join(s.board, "comments", key, `${id}.md`));
  await call(s, "POST", `/comments/${id}/ops`, { cookie: s.admin, body: { op: "resolve" } });
  const after = fs.readFileSync(path.join(s.board, "comments", key, `${id}.md`));

  // §5.3: byte-identical. Rewriting the field is what would make two clones
  // touching the same comment a merge conflict.
  assert.deepEqual(after, original);
  assert.deepEqual(commentFiles(s, key), [`${id}.md`, `${id}.ops.jsonl`]);
});

test("the current state is what replaying the ops says", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const id = await comment(s, key, "질문", "question");

  const state = async (): Promise<boolean> => {
    const listed = await call(s, "GET", `/issues/${key}/comments`, { cookie: s.admin });
    const [found] = listed.json.comments as unknown as Array<Record<string, unknown>>;
    return found.resolved as boolean;
  };

  await call(s, "POST", `/comments/${id}/ops`, { cookie: s.admin, body: { op: "resolve" } });
  assert.equal(await state(), true);

  await call(s, "POST", `/comments/${id}/ops`, { cookie: s.admin, body: { op: "unresolve" } });
  assert.equal(await state(), false, "the last op wins, because state is replayed");

  await call(s, "POST", `/comments/${id}/ops`, { cookie: s.admin, body: { op: "resolve" } });
  assert.equal(await state(), true);

  const ops = fs
    .readFileSync(path.join(s.board, "comments", key, `${id}.ops.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  assert.equal(ops.length, 3, "all three are kept; none replaced another");
});

test("replay does not depend on the order the lines sit in", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const id = await comment(s, key, "질문", "question");

  await call(s, "POST", `/comments/${id}/ops`, { cookie: s.admin, body: { op: "resolve" } });
  await call(s, "POST", `/comments/${id}/ops`, { cookie: s.admin, body: { op: "unresolve" } });

  const file = path.join(s.board, "comments", key, `${id}.ops.jsonl`);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  assert.equal(lines.length, 2);

  // What a merge does: the same ops, in the other order in the file. S4-D3 says
  // `op_id` decides, so the answer must not move.
  fs.writeFileSync(file, `${lines.reverse().join("\n")}\n`);
  await call(s, "POST", "/index/rebuild", { cookie: s.admin });

  const listed = await call(s, "GET", `/issues/${key}/comments`, { cookie: s.admin });
  const [found] = listed.json.comments as unknown as Array<Record<string, unknown>>;
  assert.equal(found.resolved, false, "still the later op, whichever line came first");
});

test("an edit changes what is shown and not what was written", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const id = await comment(s, key, "처음 쓴 말");

  const original = fs.readFileSync(path.join(s.board, "comments", key, `${id}.md`), "utf8");
  await call(s, "POST", `/comments/${id}/ops`, {
    cookie: s.admin, body: { op: "edit", body: "고쳐 쓴 말" },
  });

  const listed = await call(s, "GET", `/issues/${key}/comments`, { cookie: s.admin });
  const [found] = listed.json.comments as unknown as Array<Record<string, unknown>>;
  assert.equal(found.body, "고쳐 쓴 말");
  assert.ok(
    fs.readFileSync(path.join(s.board, "comments", key, `${id}.md`), "utf8") === original,
    "the original text is still on disk",
  );
});

test("a deleted comment leaves the list but not the disk", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const kept = await comment(s, key, "남을 말");
  const gone = await comment(s, key, "지울 말");

  await call(s, "POST", `/comments/${gone}/ops`, { cookie: s.admin, body: { op: "delete" } });

  const listed = await call(s, "GET", `/issues/${key}/comments`, { cookie: s.admin });
  const ids = (listed.json.comments as unknown as Array<{ comment_id: string }>)
    .map((entry) => entry.comment_id);
  assert.deepEqual(ids, [kept]);

  // §5.3: the record of what was said, and of it being withdrawn, both stay.
  assert.ok(fs.existsSync(path.join(s.board, "comments", key, `${gone}.md`)));
  assert.ok(fs.existsSync(path.join(s.board, "comments", key, `${gone}.ops.jsonl`)));
});

// ── who may do what (S4-D2) ─────────────────────────────────────────────────

test("only the author may edit or delete", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const id = await comment(s, key, "루트가 쓴 말");

  for (const op of ["edit", "delete"] as const) {
    const attempt = await call(s, "POST", `/comments/${id}/ops`, {
      cookie: s.member, body: { op, ...(op === "edit" ? { body: "남의 말 고치기" } : {}) },
    });
    // Changing or removing what somebody else said is not a conversation.
    assert.equal(attempt.status, 403, op);
    assert.equal(attempt.json.error?.code, "E_COMMENT_NOT_AUTHOR");
  }
});

test("an agent may not resolve a question asked of it", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const asked = await comment(s, key, "이거 맞나요?", "question");

  const attempt = await call(s, "POST", `/comments/${asked}/ops`, {
    bearer: s.bot, body: { op: "resolve" },
  });
  // The gate exists to stop the asked party carrying on regardless. An agent
  // that can close the question is not gated by it at all (§6.3).
  assert.equal(attempt.status, 403);
  assert.equal(attempt.json.error?.code, "E_COMMENT_NOT_RESOLVABLE");

  // Its own comment is its own business.
  const mine = await comment(s, key, "제가 남긴 메모", "question", "bot");
  const own = await call(s, "POST", `/comments/${mine}/ops`, {
    bearer: s.bot, body: { op: "resolve" },
  });
  assert.equal(own.status, 200, JSON.stringify(own.json));

  // And a person can settle theirs.
  const byPerson = await call(s, "POST", `/comments/${asked}/ops`, {
    cookie: s.member, body: { op: "resolve" },
  });
  assert.equal(byPerson.status, 200);
});

test("issue:comment is what a comment needs, and all it gets", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);

  const narrow = await call(s, "POST", "/tokens", {
    cookie: s.admin, body: { user: "bot", scopes: ["issue:read"] },
  });
  const refused = await call(s, "POST", `/issues/${key}/comments`, {
    bearer: narrow.json.token as unknown as string, body: { body: "쓸 수 있나" },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error?.code, "E_TOKEN_SCOPE");

  // With it, commenting works and nothing beside it does (AC16).
  const commenter = await call(s, "POST", "/tokens", {
    cookie: s.admin, body: { user: "bot", scopes: ["issue:read", "issue:comment"] },
  });
  const bearer = commenter.json.token as unknown as string;
  assert.equal(
    (await call(s, "POST", `/issues/${key}/comments`, { bearer, body: { body: "됩니다" } })).status,
    201,
  );

  const current = await call(s, "GET", `/issues/${key}`, { bearer });
  const moved = await call(s, "POST", `/issues/${key}/transitions`, {
    bearer, etag: current.etag ?? undefined, body: { to: "TODO" },
  });
  assert.equal(moved.status, 403);
  assert.equal(
    (await call(s, "DELETE", `/issues/${key}`, { bearer, etag: current.etag ?? undefined })).status,
    403,
  );
});

// ── durability ──────────────────────────────────────────────────────────────

test("comments and their resolution survive losing the index", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const asked = await comment(s, key, "질문", "question");
  await comment(s, key, "결정 사항", "decision");
  const gone = await comment(s, key, "철회할 말");
  await call(s, "POST", `/comments/${asked}/ops`, { cookie: s.admin, body: { op: "resolve" } });
  await call(s, "POST", `/comments/${gone}/ops`, { cookie: s.admin, body: { op: "delete" } });

  const before = await call(s, "GET", `/issues/${key}/comments`, { cookie: s.admin });
  await call(s, "POST", "/index/rebuild", { cookie: s.admin });
  const after = await call(s, "GET", `/issues/${key}/comments`, { cookie: s.admin });

  // AC2 names resolve ops explicitly: the index is derived, so the replay has
  // to produce the same answer from the files alone.
  assert.deepEqual(after.json.comments, before.json.comments);
});

test("two clones commenting on one issue do not collide", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const mine = await comment(s, key, "이쪽에서 남긴 말");

  // What a pull brings: another clone's comment, which is its own file.
  const theirs = "01KOTHERCLONE00000000000AA";
  fs.writeFileSync(
    path.join(s.board, "comments", key, `${theirs}.md`),
    `---\ncomment_id: ${theirs}\nauthor_id: other\nauthor_name: 다른 사람\nactor_kind: human\nkind: general\ncreated_at: 2026-07-30T00:00:00Z\nschema_version: 1\n---\n\n저쪽에서 남긴 말\n`,
  );
  await call(s, "POST", "/index/rebuild", { cookie: s.admin });

  const listed = await call(s, "GET", `/issues/${key}/comments`, { cookie: s.admin });
  const ids = (listed.json.comments as unknown as Array<{ comment_id: string }>)
    .map((entry) => entry.comment_id);

  // AC11, §5.3: different paths, so git had nothing to reconcile and both are
  // simply there.
  assert.equal(ids.length, 2, ids.join(", "));
  assert.ok(ids.includes(mine));
  assert.ok(ids.includes(theirs));
});

test("a broken op line quarantines its comment and leaves the rest working", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const broken = await comment(s, key, "로그가 깨질 말", "question");
  const fine = await comment(s, key, "멀쩡한 말", "question");
  await call(s, "POST", `/comments/${broken}/ops`, { cookie: s.admin, body: { op: "resolve" } });
  await call(s, "POST", `/comments/${fine}/ops`, { cookie: s.admin, body: { op: "resolve" } });

  fs.appendFileSync(
    path.join(s.board, "comments", key, `${broken}.ops.jsonl`),
    "{ this is not json\n",
  );
  await call(s, "POST", "/index/rebuild", { cookie: s.admin });

  // §5.6, AC10: one unreadable file must not take the board with it.
  const listed = await call(s, "GET", `/issues/${key}/comments`, { cookie: s.admin });
  assert.equal(listed.status, 200);
  const ids = (listed.json.comments as unknown as Array<{ comment_id: string }>)
    .map((entry) => entry.comment_id);
  assert.ok(ids.includes(fine), "the other comment is untouched");

  const health = await call(s, "GET", "/integrity/issues", { cookie: s.admin });
  const paths = (health.json.quarantined as unknown as Array<{ path: string }>)
    .map((entry) => entry.path);
  assert.ok(
    paths.some((entry) => entry.includes(`${broken}.ops.jsonl`)),
    paths.join(", "),
  );
});

test("the same Idempotency-Key does not write a second comment", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);

  const first = await call(s, "POST", `/issues/${key}/comments`, {
    cookie: s.admin, key: "K", body: { body: "한 번만" },
  });
  const again = await call(s, "POST", `/issues/${key}/comments`, {
    cookie: s.admin, key: "K", body: { body: "한 번만" },
  });

  // r15's last criterion, which could not close before comments existed.
  assert.equal(first.status, 201);
  assert.deepEqual(again.json, first.json);
  assert.equal(commentFiles(s, key).length, 1);
});

test("adding and resolving are both on the record, with the actor kind", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const id = await comment(s, key, "질문", "question", "bot");
  await call(s, "POST", `/comments/${id}/ops`, { cookie: s.admin, body: { op: "resolve" } });

  const root = path.join(s.board, "events");
  const lines: Array<Record<string, unknown>> = [];
  for (const day of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, day))) {
      for (const line of fs.readFileSync(path.join(root, day, file), "utf8").split("\n")) {
        if (line.trim() !== "") {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        }
      }
    }
  }

  const added = lines.find((event) => event.verb === "comment.added");
  const resolved = lines.find((event) => event.verb === "comment.resolved");
  assert.ok(added, "the comment is recorded");
  assert.ok(resolved, "and so is settling it");
  // §8: an agent's words must not read as a person's.
  assert.equal(added.actor_kind, "agent");
  assert.equal(resolved.actor_kind, "human");
});

// ── gating (r19b) ───────────────────────────────────────────────────────────

async function refined(s: Session, title = "정제된 일"): Promise<string> {
  const key = await anIssue(s, title);
  const current = await call(s, "GET", `/issues/${key}`, { cookie: s.admin });
  const moved = await call(s, "POST", `/issues/${key}/transitions`, {
    cookie: s.admin, etag: current.etag ?? undefined, body: { to: "TODO" },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  return key;
}

async function runFor(s: Session, issue: string): Promise<string> {
  const started = await call(s, "POST", "/runs", {
    bearer: s.bot,
    body: {
      issue, session_id: "s", agent_id: "bot", initiated_by: "root", branch: "b",
    },
  });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  return started.json.run_id as unknown as string;
}

test("an unanswered question stops an agent picking the issue up", async (t) => {
  const s = await session(t);
  const key = await refined(s);
  const asked = await comment(s, key, "이 방향이 맞나요?", "question");
  const runId = await runFor(s, key);

  const refused = await call(s, "POST", `/issues/${key}/claim`, {
    bearer: s.bot, body: { run_id: runId },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error?.code, "E_CLAIM_UNANSWERED");
  // The agent has to be able to say what is in the way, and to whom.
  assert.equal(
    (refused.json.unresolved_comments as unknown as Array<{ comment_id: string }>)[0].comment_id,
    asked,
  );

  // AC22: answered, and it moves.
  await call(s, "POST", `/comments/${asked}/ops`, { cookie: s.admin, body: { op: "resolve" } });
  const taken = await call(s, "POST", `/issues/${key}/claim`, {
    bearer: s.bot, body: { run_id: runId },
  });
  assert.equal(taken.status, 200, JSON.stringify(taken.json));
});

test("a review request gates too, and general and decision do not", async (t) => {
  const s = await session(t);

  const review = await refined(s, "리뷰 요청이 걸린 일");
  await comment(s, review, "봐 주세요", "review_request");
  const blocked = await call(s, "POST", `/issues/${review}/claim`, {
    bearer: s.bot, body: { run_id: await runFor(s, review) },
  });
  assert.equal(blocked.status, 409);

  // §6.3 names exactly two kinds. Gating on the others would make every note
  // a stop sign.
  const chatty = await refined(s, "말만 많은 일");
  await comment(s, chatty, "고생하셨습니다", "general");
  await comment(s, chatty, "이렇게 가기로 했습니다", "decision");
  const fine = await call(s, "POST", `/issues/${chatty}/claim`, {
    bearer: s.bot, body: { run_id: await runFor(s, chatty) },
  });
  assert.equal(fine.status, 200, JSON.stringify(fine.json));
});

test("unresolving blocks again, and deleting stops blocking", async (t) => {
  const s = await session(t);
  const key = await refined(s);
  const asked = await comment(s, key, "질문", "question");
  const runId = await runFor(s, key);

  await call(s, "POST", `/comments/${asked}/ops`, { cookie: s.admin, body: { op: "resolve" } });
  assert.equal(
    (await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } }))
      .status,
    200,
  );
  await call(s, "DELETE", `/issues/${key}/claim`, { cookie: s.admin });

  // The gate reads the replayed state, not a stored flag, so reopening the
  // question closes it again.
  await call(s, "POST", `/comments/${asked}/ops`, { cookie: s.admin, body: { op: "unresolve" } });
  const again = await runFor(s, key);
  assert.equal(
    (await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: again } }))
      .status,
    409,
  );

  // A withdrawn question is not an unanswered one.
  await call(s, "POST", `/comments/${asked}/ops`, { cookie: s.admin, body: { op: "delete" } });
  const third = await runFor(s, key);
  assert.equal(
    (await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: third } }))
      .status,
    200,
  );
});

test("an unanswered question stops DONE, for an agent", async (t) => {
  const s = await session(t);
  const key = await refined(s);
  const runId = await runFor(s, key);
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });

  for (const to of ["IN_PROGRESS", "IN_REVIEW"]) {
    const current = await call(s, "GET", `/issues/${key}`, { bearer: s.bot });
    const moved = await call(s, "POST", `/issues/${key}/transitions`, {
      bearer: s.bot, etag: current.etag ?? undefined, body: { to },
    });
    assert.equal(moved.status, 200, `${to}: ${JSON.stringify(moved.json)}`);
  }

  // Asked after the work started, which is the case §6.3 is about.
  const asked = await comment(s, key, "이대로 끝내도 되나요?", "question");

  const current = await call(s, "GET", `/issues/${key}`, { bearer: s.bot });
  const refused = await call(s, "POST", `/issues/${key}/transitions`, {
    bearer: s.bot, etag: current.etag ?? undefined, body: { to: "DONE" },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error?.code, "E_DONE_UNANSWERED");

  // §6.3 blocks claim and DONE, and nothing between them.
  await call(s, "POST", `/comments/${asked}/ops`, { cookie: s.admin, body: { op: "resolve" } });
  const after = await call(s, "GET", `/issues/${key}`, { bearer: s.bot });
  const done = await call(s, "POST", `/issues/${key}/transitions`, {
    bearer: s.bot, etag: after.etag ?? undefined, body: { to: "DONE" },
  });
  assert.equal(done.status, 200, JSON.stringify(done.json));
});

test("a person is not locked out by a question only they can answer", async (t) => {
  const s = await session(t);
  const key = await refined(s);
  await comment(s, key, "이거 맞나요?", "question");

  // S4-D4 reads §6.3 the way §6.1 reads people. Blocking here would mean the
  // only way out of your own board is answering your own question.
  for (const to of ["IN_PROGRESS", "IN_REVIEW", "DONE"]) {
    const current = await call(s, "GET", `/issues/${key}`, { cookie: s.admin });
    const moved = await call(s, "POST", `/issues/${key}/transitions`, {
      cookie: s.admin, etag: current.etag ?? undefined, body: { to },
    });
    assert.equal(moved.status, 200, `${to}: ${JSON.stringify(moved.json)}`);
  }
});

test("the two ways of being blocked are told apart", async (t) => {
  const s = await session(t);
  const waiting = await refined(s, "선행 대기");
  const asked = await refined(s, "질문 대기");
  const blocker = await refined(s, "선행");

  const detail = await call(s, "GET", `/issues/${waiting}`, { cookie: s.admin });
  const blockerDetail = await call(s, "GET", `/issues/${blocker}`, { cookie: s.admin });
  await call(s, "POST", `/issues/${waiting}/links`, {
    cookie: s.admin, etag: detail.etag ?? undefined,
    body: { kind: "blocked_by", to: blockerDetail.json.uid },
  });
  await comment(s, asked, "질문", "question");

  const first = await fetch(`${s.server.url}/issues/${waiting}`, { headers: { cookie: s.admin } });
  const second = await fetch(`${s.server.url}/issues/${asked}`, { headers: { cookie: s.admin } });

  // One is answered by finishing another issue, the other by answering a
  // person. Merging them would send the reader looking in the wrong place.
  assert.equal(first.headers.get("x-claimable"), "false");
  assert.equal(first.headers.get("x-blocked-by"), blocker);
  assert.equal(first.headers.get("x-unanswered-comments"), null);

  assert.equal(second.headers.get("x-claimable"), "false");
  assert.equal(second.headers.get("x-blocked-by"), null);
  assert.ok(second.headers.get("x-unanswered-comments"));
});

test("a claimable listing offers nothing that claiming would refuse", async (t) => {
  const s = await session(t);
  const free = await refined(s, "빈 일");
  const asked = await refined(s, "질문 걸린 일");
  await comment(s, asked, "질문", "question");

  const listed = await call(s, "GET", "/issues?claimable=true", { bearer: s.bot });
  const keys = (listed.json.issues as unknown as Array<{ key: string }>).map((i) => i.key);

  assert.ok(keys.includes(free), keys.join(", "));
  assert.equal(keys.includes(asked), false);
});

test("a gated refusal writes nothing", async (t) => {
  const s = await session(t);
  const key = await refined(s);
  await comment(s, key, "질문", "question");
  const runId = await runFor(s, key);

  const before = spawnSync("git", ["status", "--porcelain", "-uall"], {
    cwd: s.board, encoding: "utf8",
  }).stdout;
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });
  const after = spawnSync("git", ["status", "--porcelain", "-uall"], {
    cwd: s.board, encoding: "utf8",
  }).stdout;

  assert.equal(after, before, "a refusal leaves no half-write behind");
});

// ── context (r18) ───────────────────────────────────────────────────────────

test("the context answers the six things, and carries no comment list", async (t) => {
  const s = await session(t);
  const key = await refined(s);
  const blocker = await refined(s, "선행");

  const detail = await call(s, "GET", `/issues/${key}`, { cookie: s.admin });
  const blockerDetail = await call(s, "GET", `/issues/${blocker}`, { cookie: s.admin });
  await call(s, "POST", `/issues/${key}/links`, {
    cookie: s.admin, etag: detail.etag ?? undefined,
    body: { kind: "blocked_by", to: blockerDetail.json.uid },
  });
  await call(s, "PATCH", `/issues/${key}`, {
    cookie: s.admin,
    etag: (await call(s, "GET", `/issues/${key}`, { cookie: s.admin })).etag ?? undefined,
    body: { acceptance: [{ text: "테스트가 통과한다" }] },
  });
  await comment(s, key, "잡담입니다", "general");
  await comment(s, key, "이 방향으로 갑시다", "decision");

  const found = await call(s, "GET", `/issues/${key}/context`, { bearer: s.bot });
  assert.equal(found.status, 200, JSON.stringify(found.json));

  const body = found.json as unknown as Record<string, never>;
  assert.ok(body.etag, "the ETag it will send back as If-Match");
  assert.ok((body.goal as unknown as { title: string }).title);
  assert.equal(
    (body.acceptance as unknown as Array<{ text: string }>)[0].text,
    "테스트가 통과한다",
  );
  assert.equal(
    (body.dependencies as unknown as { blocked_by: Array<{ key: string }> }).blocked_by[0].key,
    blocker,
  );
  assert.ok((body.allowed as unknown as { scopes: string[] }).scopes.includes("issue:read"));

  // §6.2's actual instruction: do not leave the agent reading everything to
  // find the one line that was direction.
  assert.equal("comments" in body, false);
  assert.equal(JSON.stringify(body).includes("잡담입니다"), false);
});

test("the latest instruction is a person's question or decision, not their applause", async (t) => {
  const s = await session(t);
  const key = await refined(s);

  await comment(s, key, "이렇게 갑시다", "decision");
  await comment(s, key, "고생하셨습니다", "general");
  await comment(s, key, "에이전트가 남긴 결정", "decision", "bot");

  const found = await call(s, "GET", `/issues/${key}/context`, { bearer: s.bot });
  const instruction = found.json.latest_instruction as unknown as Record<string, unknown>;

  // S4-D5: human, and meant as direction. The agent's own note is not an
  // instruction to itself, and "고생하셨습니다" in that slot is worse than
  // nothing.
  assert.equal(instruction.body, "이렇게 갑시다");
  assert.equal(instruction.kind, "decision");
});

test("no instruction is a normal answer", async (t) => {
  const s = await session(t);
  const key = await refined(s);
  const found = await call(s, "GET", `/issues/${key}/context`, { bearer: s.bot });
  assert.equal(found.json.latest_instruction, null);
});

test("the context's ETag is the issue's own", async (t) => {
  const s = await session(t);
  const key = await refined(s);

  const found = await call(s, "GET", `/issues/${key}/context`, { bearer: s.bot });
  const etag = found.json.etag as unknown as string;

  // R10: the same strong ETag, not a token of its own. An agent has to be able
  // to send it straight back.
  const edited = await call(s, "PATCH", `/issues/${key}`, {
    cookie: s.admin, etag, body: { title: "컨텍스트의 ETag로 고침" },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));

  // And once somebody else has moved, it is refused with the current document.
  const stale = await call(s, "PATCH", `/issues/${key}`, {
    cookie: s.admin, etag, body: { title: "같은 ETag로 또" },
  });
  assert.equal(stale.status, 412);
  assert.ok(stale.json.document, "412 carries the document, the ETag and the rejected values");
  assert.ok(stale.json.etag);
});

test("both ways of being blocked reach the context, separately", async (t) => {
  const s = await session(t);
  const key = await refined(s);
  await comment(s, key, "질문", "question");

  const found = await call(s, "GET", `/issues/${key}/context`, { bearer: s.bot });
  assert.equal(found.json.claimable, false);
  const reasons = found.json.blocked_reason as unknown as Array<{ kind: string }>;
  assert.deepEqual(reasons.map((entry) => entry.kind), ["unanswered_comments"]);
});

test("a former key resolves to the same context", async (t) => {
  const s = await session(t);
  const key = await refined(s);

  // D3, AC25: an old key keeps working, so an agent holding one from before a
  // rekey is not stranded.
  const file = path.join(s.board, "issues", "LJ", `${key}.md`);
  const text = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, text.replace("former_keys: []", "former_keys: [LJ-999]"));
  await call(s, "POST", "/index/rebuild", { cookie: s.admin });

  const viaOld = await call(s, "GET", "/issues/LJ-999/context", { bearer: s.bot });
  assert.equal(viaOld.status, 200, JSON.stringify(viaOld.json));
  assert.equal((viaOld.json.issue as unknown as { key: string }).key, key);
});

test("a quarantined issue answers with the quarantine, not a context", async (t) => {
  const s = await session(t);
  const key = await refined(s);

  fs.appendFileSync(
    path.join(s.board, "issues", "LJ", `${key}.md`),
    "\n<<<<<<< HEAD\nconflict\n=======\nmarker\n>>>>>>> other\n",
  );
  await call(s, "POST", "/index/rebuild", { cookie: s.admin });

  // §5.6, AC10. An agent handed a plausible context assembled from a document
  // nobody could parse would carry on into a broken issue.
  const found = await call(s, "GET", `/issues/${key}/context`, { bearer: s.bot });
  assert.equal(found.status, 409);
  assert.equal(found.json.quarantined, true);
  assert.ok(String(found.json.path).endsWith(`${key}.md`));

  // The same answer from the route people actually use. A full rebuild leaves
  // no `issues` row to join against — which is precisely the state after a
  // `git clean` or a schema bump — and the two routes must not disagree about
  // whether the issue exists.
  const detail = await call(s, "GET", `/issues/${key}`, { cookie: s.admin });
  assert.equal(detail.status, 409, JSON.stringify(detail.json));
  assert.equal(detail.json.error?.code, "E_ISSUE_QUARANTINED");
});

test("a token without issue:read gets no context", async (t) => {
  const s = await session(t);
  const key = await refined(s);
  const narrow = await call(s, "POST", "/tokens", {
    cookie: s.admin, body: { user: "bot", scopes: ["run:write"] },
  });

  const refused = await call(s, "GET", `/issues/${key}/context`, {
    bearer: narrow.json.token as unknown as string,
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error?.code, "E_TOKEN_SCOPE");
});

test("reading a context records nothing", async (t) => {
  const s = await session(t);
  const key = await refined(s);

  const count = (): number => {
    const root = path.join(s.board, "events");
    let found = 0;
    for (const day of fs.readdirSync(root)) {
      for (const file of fs.readdirSync(path.join(root, day))) {
        found += fs
          .readFileSync(path.join(root, day, file), "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "").length;
      }
    }
    return found;
  };

  const before = count();
  for (let index = 0; index < 5; index += 1) {
    await call(s, "GET", `/issues/${key}/context`, { bearer: s.bot });
  }
  // N7 excludes reads. An agent polling for work would otherwise be the
  // loudest writer on the board.
  assert.equal(count(), before);
});


// ── 격리가 새 이슈를 막지 않는다 (r01d 중 발견) ────────────────────────────

test("a broken file does not stop the board minting new keys", async (t) => {
  const s = await session(t);
  const broken = await anIssue(s, "곧 깨질 이슈");

  fs.appendFileSync(
    path.join(s.board, "issues", "LJ", `${broken}.md`),
    "\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> z\n",
  );
  await call(s, "POST", "/index/rebuild", { cookie: s.admin });

  // A full rebuild leaves no `issues` row for a file that never parsed, so the
  // key allocator could not see that LJ-1 was taken and handed it out again —
  // the file-exists guard then refused *every* new issue until somebody
  // repaired that one file. One broken document must not stop the board.
  const created = await call(s, "POST", "/issues", {
    cookie: s.admin, body: { project: "LJ", type: "task", title: "그래도 만들어진다" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.notEqual(created.json.key, broken);

  // And the broken one is still there, still quarantined, not overwritten.
  const held = await call(s, "GET", `/issues/${broken}`, { cookie: s.admin });
  assert.equal(held.status, 409);
  assert.equal(held.json.error?.code, "E_ISSUE_QUARANTINED");
});
