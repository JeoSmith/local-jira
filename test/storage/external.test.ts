import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bootstrapAdmin } from "../../src/domain/users.ts";
import { startServer, type RunningServer } from "../../src/server/http.ts";
import { openBoardForWriting } from "../../src/storage/board.ts";
import { reconcileExternal } from "../../src/storage/external.ts";
import { watchBoard } from "../../src/storage/watcher.ts";

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-ext-")));
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

async function signIn(sandbox: Sandbox, options: { watch?: boolean; debounceMs?: number } = {}): Promise<Session> {
  const server = await startServer({ cwd: sandbox.repo, port: 0, ...options });
  const response = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "admin", password: PASSWORD }),
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

function issueFile(sandbox: Sandbox, key: string): string {
  return path.join(sandbox.board, "issues", "LJ", `${key}.md`);
}

function events(sandbox: Sandbox): Array<Record<string, unknown>> {
  const root = path.join(sandbox.board, "events");
  if (!fs.existsSync(root)) {
    return [];
  }
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
  return lines;
}

async function seed(session: Session, title = "외부 편집 대상") {
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "story", title },
  });
  assert.equal(created.status, 201);
  return { key: created.json.key as unknown as string, etag: created.etag ?? "" };
}

// ── the watcher is a hint ───────────────────────────────────────────────────

test("collapses a burst of events into one batch", async (t) => {
  const sandbox = await makeSandbox(t);
  const target = path.join(sandbox.board, "issues", "LJ");
  fs.mkdirSync(target, { recursive: true });

  let batches = 0;
  const watcher = watchBoard(sandbox.board, {
    debounceMs: 300,
    onBatch: () => {
      batches += 1;
    },
  });
  t.after(() => watcher.close());

  // What an editor save looks like: temp files, renames, many events.
  for (let index = 0; index < 20; index += 1) {
    fs.writeFileSync(path.join(target, "LJ-1.md"), `---\nkey: LJ-1\n---\n${index}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.equal(batches, 1, `expected one batch, saw ${batches}`);
});

test("converges without the watcher having fired at all", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, { watch: false });
  t.after(() => session.server.close());

  const { key } = await seed(session);
  fs.writeFileSync(
    issueFile(sandbox, key),
    fs.readFileSync(issueFile(sandbox, key), "utf8").replace("외부 편집 대상", "워처 없이 반영"),
  );

  // The watcher is a hint; reconciliation from disk is the source of truth.
  await session.server.reconcile();

  const shown = await call(session, "GET", `/issues/${key}`);
  assert.equal((shown.json as unknown as Record<string, unknown>).title, "워처 없이 반영");
});

// ── echo suppression ────────────────────────────────────────────────────────

test("a write the server made is not reported as external", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, { watch: false });
  t.after(() => session.server.close());

  const { key, etag } = await seed(session);
  await call(session, "PUT", `/issues/${key}`, { ifMatch: etag, body: { points: 5 } });

  const before = events(sandbox).length;
  await session.server.reconcile();

  // The index already holds the hash of what the server wrote, so the scan
  // sees no difference and invents nothing.
  assert.equal(events(sandbox).length, before);
  assert.equal(
    events(sandbox).some((event) => event.actor_kind === "external"),
    false,
  );
});

test("an edit right after an API write is external, not an echo", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, { watch: false });
  t.after(() => session.server.close());

  const { key, etag } = await seed(session);
  await call(session, "PUT", `/issues/${key}`, { ifMatch: etag, body: { points: 5 } });

  fs.writeFileSync(
    issueFile(sandbox, key),
    fs.readFileSync(issueFile(sandbox, key), "utf8").replace("points: 5", "points: 8"),
  );
  await session.server.reconcile();

  const external = events(sandbox).filter((event) => event.actor_kind === "external");
  assert.equal(external.length, 1, "content differs from what the server recorded");
});

test("records an external change without inventing an actor", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, { watch: false });
  t.after(() => session.server.close());

  const { key } = await seed(session);
  fs.writeFileSync(
    issueFile(sandbox, key),
    fs.readFileSync(issueFile(sandbox, key), "utf8").replace("외부 편집 대상", "에디터로 고침"),
  );
  await session.server.reconcile();

  const external = events(sandbox).find((event) => event.actor_kind === "external");
  assert.ok(external);
  assert.equal(external.actor_id, "unknown");
  assert.equal(external.verb, "issue.changed_externally");
  // §5.7: a git author is a guess, never promoted to an authenticated actor.
  assert.equal((external.detail as Record<string, unknown>).source_commit, null);
});

test("an external edit moves the ETag and invalidates the old one", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, { watch: false });
  t.after(() => session.server.close());

  const { key, etag } = await seed(session);
  fs.writeFileSync(
    issueFile(sandbox, key),
    fs.readFileSync(issueFile(sandbox, key), "utf8").replace("외부 편집 대상", "밖에서 바뀐 제목"),
  );
  await session.server.reconcile();

  const shown = await call(session, "GET", `/issues/${key}`);
  assert.notEqual(shown.etag, etag);

  const stale = await call(session, "PUT", `/issues/${key}`, {
    ifMatch: etag,
    body: { title: "덮어쓰기 시도" },
  });
  assert.equal(stale.status, 412);
});

test("survives an externally broken file", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, { watch: false });
  t.after(() => session.server.close());

  const healthy = await seed(session, "정상 이슈");
  const broken = await seed(session, "곧 깨질 이슈");
  fs.writeFileSync(issueFile(sandbox, broken.key), "이건 frontmatter가 아니다\n");

  await session.server.reconcile();

  // One unreadable file must not take the board down with it.
  const listed = await call(session, "GET", "/issues");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    (listed.json.issues as unknown as Array<{ key: string }>).map((issue) => issue.key),
    [healthy.key],
  );
});

test("indexes an op appended to a comment log without touching the original", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, { watch: false });
  t.after(() => session.server.close());

  const { key } = await seed(session);
  const directory = path.join(sandbox.board, "comments", key);
  fs.mkdirSync(directory, { recursive: true });
  const body = "---\ncomment_id: 01JC1\nkind: question\n---\n질문\n";
  fs.writeFileSync(path.join(directory, "01JC1.md"), body);
  fs.writeFileSync(
    path.join(directory, "01JC1.ops.jsonl"),
    `${JSON.stringify({ op_id: "01JOP1", op: "resolve" })}\n`,
  );

  await session.server.reconcile();

  const writable = await openBoardForWriting(sandbox.repo).catch(() => null);
  assert.equal(writable, null, "the server still holds the writer lock");

  const comment = await call(session, "GET", `/issues/${key}`);
  assert.equal(comment.status, 200);
  assert.equal(fs.readFileSync(path.join(directory, "01JC1.md"), "utf8"), body);
});

// ── SSE ─────────────────────────────────────────────────────────────────────

/**
 * Opens an SSE connection with node:http rather than fetch.
 *
 * fetch's stream is awkward to abandon deterministically in a test, and a
 * connection left half-open is what makes a suite hang rather than fail.
 */
function openStream(
  session: Session,
  headers: Record<string, string> = {},
): {
  text(): string;
  wait(marker: string, timeoutMs: number): Promise<string>;
  waitForClose(timeoutMs: number): Promise<void>;
  close(): void;
} {
  const url = new URL(`${session.server.url}/stream`);
  let received = "";
  let ended = false;

  const request = http.get(
    {
      hostname: url.hostname,
      port: url.port,
      path: "/stream",
      headers: { cookie: session.cookie, ...headers },
    },
    (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        received += chunk;
      });
      response.on("end", () => {
        ended = true;
      });
    },
  );

  return {
    text: () => received,
    async wait(marker, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (received.includes(marker)) {
          return received;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`did not see "${marker}" in ${timeoutMs}ms. Got: ${received}`);
    },
    async waitForClose(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (ended) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`stream remained open for ${timeoutMs}ms`);
    },
    close: () => request.destroy(),
  };
}

test("pushes API changes and closes the stream on logout", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, { watch: false });
  const stream = openStream(session);
  t.after(() => stream.close());
  t.after(() => session.server.close());
  await new Promise((resolve) => setTimeout(resolve, 100));

  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "story", title: "API 실시간 반영" },
  });
  const message = await stream.wait("event: issue.changed", 1_000);
  assert.match(message, new RegExp(String(created.json.key)));
  assert.match(message, /"source":"api"/);
  assert.match(message, /"action":"created"/);

  await call(session, "POST", "/auth/logout");
  await stream.waitForClose(1_000);
});

test("pushes an external change to a connected client within 3 seconds", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, { debounceMs: 100 });
  const { key } = await seed(session);

  const stream = openStream(session);
  t.after(() => stream.close());
  t.after(() => session.server.close());
  await new Promise((resolve) => setTimeout(resolve, 150));

  const started = Date.now();
  fs.writeFileSync(
    issueFile(sandbox, key),
    fs.readFileSync(issueFile(sandbox, key), "utf8").replace("외부 편집 대상", "실시간 반영"),
  );

  const message = await stream.wait("issue.changed", 3_000);
  assert.ok(Date.now() - started < 3_000, "AC3 allows three seconds");
  assert.match(message, new RegExp(key));
  assert.match(message, /"source":"external"/);
  assert.match(message, /^id: [0-9A-HJKMNP-TV-Z]{26}-\d+$/m);
});

test("tells a client from a previous run to resync", async (t) => {
  const sandbox = await makeSandbox(t);
  const session = await signIn(sandbox, { watch: false });

  // An id minted by an earlier process: same shape, different epoch. Replying
  // "nothing since" would look like quiet rather than like a gap.
  const stream = openStream(session, { "last-event-id": "01JOLDEPOCH0000000000000AA-7" });
  t.after(() => stream.close());
  t.after(() => session.server.close());

  const message = await stream.wait("event: resync", 3_000);
  assert.match(message, /event: resync/);
});
