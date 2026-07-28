import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ACTOR_KINDS, buildEvent, redact, VERBS } from "../../src/domain/events.ts";
import { bootstrapAdmin, createUser } from "../../src/domain/users.ts";
import { startServer, type RunningServer } from "../../src/server/http.ts";
import { openBoardForWriting } from "../../src/storage/board.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
}

function cli(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

interface Sandbox {
  repo: string;
  board: string;
}

async function makeSandbox(t: { after: (fn: () => void) => void }): Promise<Sandbox> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-evt-")));
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
  createUser(board.board, { id: "dev", displayName: "개발자", role: "member", password: PASSWORD });
  await board.close();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { repo, board: path.join(repo, ".localjira") };
}

interface Session {
  server: RunningServer;
  cookie: string;
}

async function signIn(sandbox: Sandbox, id = "admin"): Promise<Session> {
  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  const response = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  return { server, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] };
}

async function call(session: Session, method: string, route: string, options: { body?: unknown; ifMatch?: string } = {}) {
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
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
  };
}

interface EventRecord {
  event_id: string;
  at: string;
  actor_id: string | null;
  actor_kind: string;
  run_id: string | null;
  initiated_by: string | null;
  target_kind: string;
  target_uid: string | null;
  verb: string;
  before: unknown;
  after: unknown;
  detail?: Record<string, unknown>;
}

function events(sandbox: Sandbox): EventRecord[] {
  const root = path.join(sandbox.board, "events");
  if (!fs.existsSync(root)) {
    return [];
  }
  const records: EventRecord[] = [];
  for (const day of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, day))) {
      for (const line of fs.readFileSync(path.join(root, day, file), "utf8").split("\n")) {
        if (line.trim() !== "") {
          records.push(JSON.parse(line) as EventRecord);
        }
      }
    }
  }
  return records.sort((a, b) => a.at.localeCompare(b.at) || a.event_id.localeCompare(b.event_id));
}

// ── shape ───────────────────────────────────────────────────────────────────

test("every record carries the same fields", () => {
  const built = buildEvent("/nowhere", {
    verb: "issue.updated",
    targetKind: "issue",
    targetUid: "01JX",
    actor: { id: "u", kind: "agent", runId: "01JRUN", initiatedBy: "admin" },
    before: { points: 3 },
    after: { points: 5 },
  });

  const record = JSON.parse(built.line) as EventRecord;
  for (const field of [
    "event_id", "at", "actor_id", "actor_kind", "run_id",
    "initiated_by", "target_kind", "target_uid", "verb", "before", "after",
  ]) {
    assert.ok(field in record, `missing ${field}`);
  }
  assert.match(record.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  // Delegated work names both the agent and the person who directed it (§6.2).
  assert.equal(record.run_id, "01JRUN");
  assert.equal(record.initiated_by, "admin");
  assert.match(built.path, /^events\/\d{4}-\d{2}-\d{2}\/[^/]+\.jsonl$/);
});

test("uses the four actor kinds and no others", () => {
  assert.deepEqual([...ACTOR_KINDS], ["human", "agent", "external", "system"]);
  assert.equal(VERBS.some((verb) => /read|list|search|view/.test(verb)), false);
});

test("strips anything secret before it can reach a file", () => {
  const redacted = redact({
    id: "admin",
    role: "admin",
    password: "plaintext",
    password_hash: "argon2id$...",
    token: "abc",
    tokenHash: "def",
    nested: { salt: "s", display_name: "관리자" },
  }) as Record<string, unknown>;

  // The event file is committed and pushed, so a leak here reaches everyone
  // with the repository.
  assert.deepEqual(redacted, { id: "admin", role: "admin", nested: { display_name: "관리자" } });
});

// ── coverage of the audit scope ─────────────────────────────────────────────

test("records one event per auditable action", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "story", title: "감사 대상", points: 3 },
  });
  const key = created.json.key as unknown as string;

  const updated = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: created.etag ?? "",
    body: { points: 8 },
  });
  const moved = await call(session, "POST", `/issues/${key}/transitions`, {
    ifMatch: updated.etag ?? "",
    body: { to: "TODO" },
  });
  await call(session, "POST", "/users", {
    body: { id: "newbie", display_name: "신규", role: "member", password: PASSWORD },
  });
  await call(session, "PUT", "/users/newbie/role", { body: { role: "admin" } });
  await call(session, "DELETE", `/issues/${key}`, { ifMatch: moved.etag ?? "" });

  const verbs = events(sandbox).map((event) => event.verb);
  assert.deepEqual(verbs, [
    "issue.created",
    "issue.updated",
    "issue.transitioned",
    "user.created",
    "user.role_changed",
    "issue.deleted",
  ]);
});

test("reads and searches record nothing", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "story", title: "조회 대상" },
  });
  const before = events(sandbox).length;

  for (let index = 0; index < 5; index += 1) {
    await call(session, "GET", "/issues");
    await call(session, "GET", "/issues/LJ-1");
    await call(session, "GET", "/issues?status=BACKLOG");
    await call(session, "GET", "/me");
  }

  // N7 excludes reads. A timeline that logged them would bury the changes.
  assert.equal(events(sandbox).length, before);
});

test("carries before and after for a field change", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "story", title: "원래 제목", points: 3 },
  });
  await call(session, "PUT", `/issues/${created.json.key as unknown as string}`, {
    ifMatch: created.etag ?? "",
    body: { title: "바뀐 제목", points: 8 },
  });

  const updated = events(sandbox).find((event) => event.verb === "issue.updated");
  assert.ok(updated);
  assert.deepEqual(updated.before, { title: "원래 제목", points: 3 });
  assert.deepEqual(updated.after, { title: "바뀐 제목", points: 8 });
  // Only the fields the request touched, so a diff is readable.
  assert.deepEqual(Object.keys(updated.after as object).sort(), ["points", "title"]);
});

test("records a transition with both statuses", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "story", title: "전이 대상" },
  });
  await call(session, "POST", `/issues/${created.json.key as unknown as string}/transitions`, {
    ifMatch: created.etag ?? "",
    body: { to: "TODO", reason: "착수" },
  });

  const moved = events(sandbox).find((event) => event.verb === "issue.transitioned");
  assert.ok(moved);
  assert.deepEqual(moved.before, { status: "BACKLOG" });
  assert.deepEqual(moved.after, { status: "TODO" });
  assert.equal(moved.detail?.reason, "착수");
});

test("records a refused operational attempt", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, "dev");
  t.after(() => session.server.close());

  const refused = await call(session, "POST", "/users", {
    body: { id: "sneaky", display_name: "x", role: "admin", password: PASSWORD },
  });
  assert.equal(refused.status, 403);

  // "Who tried to manage accounts" is exactly what N7 wants kept.
  const denied = events(sandbox).find((event) => event.verb === "access.denied");
  assert.ok(denied);
  assert.equal(denied.actor_id, "dev");
  assert.equal(denied.detail?.capability, "user:manage");
});

test("keeps no secret in an account event", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  await call(session, "POST", "/users", {
    body: { id: "newbie", display_name: "신규", role: "member", password: PASSWORD },
  });

  const raw = fs.readFileSync(
    path.join(
      sandbox.board,
      "events",
      fs.readdirSync(path.join(sandbox.board, "events"))[0],
      fs.readdirSync(path.join(sandbox.board, "events", fs.readdirSync(path.join(sandbox.board, "events"))[0]))[0],
    ),
    "utf8",
  );

  assert.equal(raw.includes(PASSWORD), false);
  assert.equal(/argon2id|password_hash|"token"/.test(raw), false);
  const created = events(sandbox).find((event) => event.verb === "user.created");
  assert.deepEqual(created?.after, { id: "newbie", displayName: "신규", role: "member" });
});

test("splits event files by day and node so clones never collide", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);
  t.after(() => session.server.close());

  await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "story", title: "분할 확인" },
  });

  const days = fs.readdirSync(path.join(sandbox.board, "events"));
  assert.equal(days.length, 1);
  assert.match(days[0], /^\d{4}-\d{2}-\d{2}$/);

  const files = fs.readdirSync(path.join(sandbox.board, "events", days[0]));
  assert.equal(files.length, 1);
  // The node id comes from .local/node.yaml, which is per installation, so a
  // second clone appends to a different file and the two never merge-conflict.
  const nodeId = /^node_id:\s*(\S+)$/m.exec(
    fs.readFileSync(path.join(sandbox.board, ".local", "node.yaml"), "utf8"),
  )?.[1];
  assert.equal(files[0], `${nodeId}.jsonl`);
});

test("survives losing the index because events live in files", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox);

  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "story", title: "인덱스 삭제 후에도" },
  });
  await call(session, "POST", `/issues/${created.json.key as unknown as string}/transitions`, {
    ifMatch: created.etag ?? "",
    body: { to: "TODO" },
  });
  const before = events(sandbox);
  await session.server.close();

  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(path.join(sandbox.board, ".local", `index.sqlite${suffix}`), { force: true });
  }

  const board = await openBoardForWriting(sandbox.repo);
  t.after(() => board.close());

  const rows = board.board.db
    .prepare("SELECT event_id, verb, actor_kind FROM events ORDER BY at, event_id")
    .all() as Array<{ event_id: string; verb: string; actor_kind: string }>;

  assert.deepEqual(
    rows.map((row) => row.verb),
    before.map((event) => event.verb),
  );
  assert.deepEqual(events(sandbox), before, "the files themselves are untouched");
});
