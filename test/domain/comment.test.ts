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
