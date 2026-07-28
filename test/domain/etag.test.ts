import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bootstrapAdmin } from "../../src/domain/users.ts";
import { startServer, type RunningServer } from "../../src/server/http.ts";
import { openBoardForWriting } from "../../src/storage/board.ts";
import { canonicalJson } from "../../src/storage/jcs.ts";
import { etagOf } from "../../src/storage/resource.ts";

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
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

async function makeSandbox(t: { after: (fn: () => void) => void }): Promise<Sandbox> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-etag-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  cli(repo, ["init", "--project-key", "LJ", "--project-name", "Local Jira", "--timezone", "Asia/Seoul"]);

  const board = await openBoardForWriting(repo);
  bootstrapAdmin(board.board, { id: "admin", displayName: "관리자", password: PASSWORD });
  await board.close();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { repo, board: path.join(repo, ".localjira") };
}

interface Session {
  server: RunningServer;
  cookie: string;
}

async function signIn(sandbox: Sandbox): Promise<Session> {
  const server = await startServer({ cwd: sandbox.repo, port: 0 });
  const response = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "admin", password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  return { server, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] };
}

async function call(
  session: Session,
  method: string,
  route: string,
  options: { body?: unknown; ifMatch?: string } = {},
) {
  const response = await fetch(`${session.server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: session.cookie,
      ...(options.ifMatch === undefined ? {} : { "if-match": options.ifMatch }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    text,
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
  };
}

async function createIssue(session: Session, title = "동시성 대상"): Promise<{ key: string; etag: string }> {
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "story", title, points: 3, labels: ["core"] },
  });
  assert.equal(created.status, 201);
  return { key: created.json.key as unknown as string, etag: created.etag ?? "" };
}

test("the ETag is the hash of the bytes actually sent", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key } = await createIssue(session);
  const shown = await call(session, "GET", `/issues/${key}`);

  assert.equal(shown.status, 200);
  // ADR-003: not the hash of some internal projection, the response body.
  assert.equal(shown.etag, `"${etagOf(shown.text)}"`);
  assert.match(shown.etag ?? "", /^"[0-9a-f]{64}"$/);
  assert.equal(shown.etag?.startsWith("W/"), false, "weak validators are not used");
  // And the body really is canonical JSON, so another implementation reading
  // the same file arrives at the same bytes and the same ETag.
  assert.equal(shown.text, canonicalJson(shown.json as never));
});

test("the second of two writers from the same read is refused", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key } = await createIssue(session);
  const read = await call(session, "GET", `/issues/${key}`);
  const e1 = read.etag ?? "";

  const first = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: e1,
    body: { title: "첫 번째가 이긴다" },
  });
  assert.equal(first.status, 200);
  const e2 = first.etag ?? "";
  assert.notEqual(e2, e1);

  const second = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: e1,
    body: { title: "두 번째는 거부된다" },
  });
  assert.equal(second.status, 412);

  // The first change survives intact and nothing of the second leaked in.
  const after = await call(session, "GET", `/issues/${key}`);
  assert.equal(after.json.title as unknown as string, "첫 번째가 이긴다");
  assert.equal(after.etag, e2);
});

test("a 412 carries the current document and the refused values", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key, etag: stale } = await createIssue(session);
  await call(session, "PUT", `/issues/${key}`, { ifMatch: stale, body: { title: "새 제목" } });

  const rejected = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: stale,
    body: { title: "내 제목", points: 8 },
  });

  assert.equal(rejected.status, 412);
  assert.equal(rejected.etag, `"${rejected.json.etag as unknown as string}"`);
  // The whole current document, so the client can merge against its own base —
  // the server does not keep one.
  assert.equal((rejected.json.document as unknown as Record<string, unknown>).title, "새 제목");
  const conflicts = rejected.json.conflicts as unknown as Record<string, { current: unknown; requested: unknown }>;
  assert.deepEqual(conflicts.title, { current: "새 제목", requested: "내 제목" });
  assert.deepEqual(conflicts.points, { current: 3, requested: 8 });
});

test("retrying with the ETag from the 412 succeeds", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key, etag: stale } = await createIssue(session);
  await call(session, "PUT", `/issues/${key}`, { ifMatch: stale, body: { title: "중간 변경" } });

  const rejected = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: stale,
    body: { title: "재시도" },
  });
  assert.equal(rejected.status, 412);

  const retried = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: rejected.etag ?? "",
    body: { title: "재시도" },
  });
  assert.equal(retried.status, 200);
  assert.equal((retried.json as unknown as Record<string, unknown>).title, "재시도");
});

test("a missing If-Match is refused with 428, not accepted", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key, etag } = await createIssue(session);

  const noHeader = await call(session, "PUT", `/issues/${key}`, { body: { title: "몰래 덮어쓰기" } });

  // Making the header optional would leave a silent last-write-wins path.
  assert.equal(noHeader.status, 428);
  assert.equal(noHeader.etag, etag, "the response tells the caller which ETag to use");

  const unchanged = await call(session, "GET", `/issues/${key}`);
  assert.equal(unchanged.etag, etag);
});

test("an external edit invalidates a held ETag", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  const { key, etag } = await createIssue(session);
  await session.server.close();

  // Someone edits the file in an editor rather than through the API.
  const file = path.join(sandbox.board, "issues", "LJ", `${key}.md`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("title: 동시성 대상", "title: 손으로 고친 제목"));

  const reopened = await signIn(sandbox);
  t.after(() => reopened.server.close());

  const stale = await call(reopened, "PUT", `/issues/${key}`, {
    ifMatch: etag,
    body: { title: "API가 이긴다" },
  });
  assert.equal(stale.status, 412, "an edit outside the API is still a conflict");
  assert.equal(
    (stale.json.document as unknown as Record<string, unknown>).title,
    "손으로 고친 제목",
  );
});

test("a no-op update changes nothing at all", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key } = await createIssue(session);
  const before = await call(session, "GET", `/issues/${key}`);
  git(sandbox.board, ["add", "-A"]);
  git(sandbox.board, ["commit", "-m", "baseline"]);

  const noop = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: before.etag ?? "",
    body: { title: before.json.title as unknown as string },
  });

  assert.equal(noop.status, 200);
  assert.equal(noop.etag, before.etag, "the ETag must not move for a no-op");
  assert.equal(
    git(sandbox.board, ["status", "--porcelain", "-uall"]).trim(),
    "",
    "a no-op must not rewrite the file or append an event",
  );
});

test("takes a hand-edited rev as the base to count on from", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  const { key } = await createIssue(session);
  await session.server.close();

  // Two clones can produce the same rev, so it must not participate in the
  // decision — it rides along as display data only (ADR-003).
  const file = path.join(sandbox.board, "issues", "LJ", `${key}.md`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^rev: \d+$/m, "rev: 7"));

  const reopened = await signIn(sandbox);
  t.after(() => reopened.server.close());

  const read = await call(reopened, "GET", `/issues/${key}`);
  assert.equal((read.json as unknown as Record<string, unknown>).rev, 7, "rev is returned");

  const updated = await call(reopened, "PUT", `/issues/${key}`, {
    ifMatch: read.etag ?? "",
    body: { title: "rev는 판정에 쓰이지 않는다" },
  });
  assert.equal(updated.status, 200, "an unexpected rev never blocks a valid ETag");
  assert.equal(
    (updated.json as unknown as Record<string, unknown>).rev,
    8,
    "the counter continues from what the file held rather than resetting",
  );
});

test("preserves unknown keys and body through an update", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  const { key } = await createIssue(session);
  await session.server.close();

  const file = path.join(sandbox.board, "issues", "LJ", `${key}.md`);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("schema_version: 1", "schema_version: 1\nmyOwnField: 유지해야 함"),
  );

  const reopened = await signIn(sandbox);
  t.after(() => reopened.server.close());

  const read = await call(reopened, "GET", `/issues/${key}`);
  const updated = await call(reopened, "PUT", `/issues/${key}`, {
    ifMatch: read.etag ?? "",
    body: { points: 13 },
  });

  assert.equal(updated.status, 200);
  assert.equal((updated.json as unknown as Record<string, unknown>).myOwnField, "유지해야 함");
  assert.match(fs.readFileSync(file, "utf8"), /^myOwnField: 유지해야 함$/m);
});

test("refuses a status change through the field update route", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key, etag } = await createIssue(session);
  const rejected = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: etag,
    body: { status: "TODO" },
  });

  // S1-D2 keeps transitions on their own endpoint so gating lives in one place.
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.error.code as unknown as string, "E_STATUS_NOT_ALLOWED");
});

test("rev is carried for display but never decides concurrency", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key } = await createIssue(session);
  const first = await call(session, "GET", `/issues/${key}`);
  assert.equal(first.json.rev as unknown as number, 1, "a new issue starts at rev 1");

  const bumped = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: first.etag ?? "",
    body: { points: 8 },
  });
  assert.equal(bumped.status, 200);
  assert.equal(bumped.json.rev as unknown as number, 2, "a change advances the counter");

  // The decisive part: a request whose rev matches the server's is still
  // refused when its ETag is stale. If rev were consulted this would pass, and
  // two clones that both went 1 → 2 offline would silently overwrite one
  // another on merge.
  const stale = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: first.etag ?? "",
    body: { points: 13, rev: 2 },
  });
  assert.equal(stale.status, 400, "rev is server-owned and cannot be supplied");
  assert.equal(
    (stale.json as unknown as { error: { code: string } }).error.code,
    "E_IMMUTABLE_FIELD",
  );

  const withoutRev = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: first.etag ?? "",
    body: { points: 13 },
  });
  assert.equal(withoutRev.status, 412, "the ETag alone decides, and it is stale");

  const unchanged = await call(session, "GET", `/issues/${key}`);
  assert.equal(unchanged.json.points as unknown as number, 8);
  assert.equal(unchanged.json.rev as unknown as number, 2, "a refused write does not advance rev");
});

test("a change stamps updated_at and the actor that made it", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const { key } = await createIssue(session);
  const before = await call(session, "GET", `/issues/${key}`);
  const createdAt = before.json.created_at as unknown as string;
  assert.equal(before.json.updated_at as unknown as string, createdAt);

  // The stamp has one-second resolution, so a same-second edit would be
  // indistinguishable from no edit at all.
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  const updated = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: before.etag ?? "",
    body: { title: "제목 변경" },
  });
  assert.equal(updated.status, 200);
  assert.ok(
    (updated.json.updated_at as unknown as string) > createdAt,
    "updated_at must move forward on a change",
  );
  assert.equal(updated.json.created_at as unknown as string, createdAt, "created_at is fixed");
  assert.equal(updated.json.last_actor_kind as unknown as string, "human");

  // A no-op must not move it: the ETag follows updated_at, and a moving ETag
  // would manufacture conflicts for clients that changed nothing.
  const noop = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: updated.etag ?? "",
    body: { title: "제목 변경" },
  });
  assert.equal(noop.status, 200);
  assert.equal(noop.etag, updated.etag);
  assert.equal(noop.json.updated_at as unknown as string, updated.json.updated_at);
  assert.equal(noop.json.rev as unknown as number, updated.json.rev);
});

test("acceptance criteria can be edited after creation", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const created = await call(session, "POST", "/issues", {
    body: {
      project: "LJ", type: "story", title: "인수조건 수정",
      acceptance: [{ text: "첫 번째" }],
    },
  });
  assert.equal(created.status, 201);
  const key = created.json.key as unknown as string;

  const edited = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: created.etag ?? "",
    body: {
      acceptance: [
        { text: "첫 번째", done: true },
        { text: "두 번째" },
      ],
    },
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.json.acceptance, [
    { done: true, id: "ac1", text: "첫 번째" },
    { done: false, id: "ac2", text: "두 번째" },
  ]);

  // Re-sending the same list is a no-op even though the request omits the
  // server-assigned ids.
  const again = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: edited.etag ?? "",
    body: { acceptance: [{ text: "첫 번째", done: true }, { text: "두 번째" }] },
  });
  assert.equal(again.status, 200);
  assert.equal(again.etag, edited.etag, "an identical list must not rewrite the file");

  const cleared = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: edited.etag ?? "",
    body: { acceptance: [] },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.acceptance, undefined, "an empty list drops the key entirely");
});
