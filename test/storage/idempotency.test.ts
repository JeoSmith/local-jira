import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { createHash } from "node:crypto";

import { startServer, type RunningServer } from "../../src/server/http.ts";
import { canonicalJson } from "../../src/storage/jcs.ts";
import { IDEMPOTENCY_TTL_MS, Outbox } from "../../src/storage/outbox.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

interface Sandbox {
  repo: string;
  board: string;
  local: string;
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-idem-")));
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
    "admin", "create", "--id", "other", "--name", "다른 사람", "--password", PASSWORD,
    "--role", "member",
  ]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  return {
    repo,
    board: path.join(repo, ".localjira"),
    local: path.join(repo, ".localjira", ".local"),
  };
}

interface Result {
  status: number;
  body: string;
  json: Record<string, never>;
  etag: string | null;
}

async function post(
  server: RunningServer,
  route: string,
  options: { body?: unknown; cookie: string; key?: string },
): Promise<Result> {
  const response = await fetch(`${server.url}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: options.cookie,
      ...(options.key === undefined ? {} : { "idempotency-key": options.key }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.text();
  return {
    status: response.status,
    body,
    json: body ? (JSON.parse(body) as Record<string, never>) : ({} as Record<string, never>),
    etag: response.headers.get("etag"),
  };
}

async function signIn(server: RunningServer, id: string): Promise<string> {
  const response = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

function issueFiles(sandbox: Sandbox): string[] {
  const directory = path.join(sandbox.board, "issues", "LJ");
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

function eventCount(sandbox: Sandbox, verb: string): number {
  const root = path.join(sandbox.board, "events");
  if (!fs.existsSync(root)) {
    return 0;
  }
  let found = 0;
  for (const day of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, day))) {
      for (const line of fs.readFileSync(path.join(root, day, file), "utf8").split("\n")) {
        if (line.trim() !== "" && (JSON.parse(line) as { verb: string }).verb === verb) {
          found += 1;
        }
      }
    }
  }
  return found;
}

const ISSUE = { project: "LJ", type: "task", title: "재시도될 이슈" };

/** The same fingerprint the server computes, so a fixture can stand in for a
 *  request that really was made. */
function fingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body as never)).digest("hex");
}

// ── the promise ─────────────────────────────────────────────────────────────

test("a retry returns the first response and creates nothing new", async (t) => {
  const sandbox = makeSandbox(t);
  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  t.after(() => server.close());
  const cookie = await signIn(server, "root");

  const first = await post(server, "/issues", { cookie, key: "K", body: ISSUE });
  assert.equal(first.status, 201);

  const again = await post(server, "/issues", { cookie, key: "K", body: ISSUE });

  // AC3: the status code, the body and the ETag — a caller that retried after a
  // timeout must not be able to tell which of its two requests it is reading.
  assert.equal(again.status, first.status);
  assert.equal(again.body, first.body);
  assert.equal(again.etag, first.etag);

  assert.equal(issueFiles(sandbox).length, 1);
  assert.equal(eventCount(sandbox, "issue.created"), 1, "and one event, not two");
});

test("without a key, two identical requests are two issues", async (t) => {
  const sandbox = makeSandbox(t);
  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  t.after(() => server.close());
  const cookie = await signIn(server, "root");

  // AC2: the header is optional, and its absence means no protection rather
  // than protection inferred from the body.
  await post(server, "/issues", { cookie, body: ISSUE });
  await post(server, "/issues", { cookie, body: ISSUE });
  assert.equal(issueFiles(sandbox).length, 2);
});

test("the key belongs to the actor, not to the board", async (t) => {
  const sandbox = makeSandbox(t);
  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  t.after(() => server.close());

  const root = await signIn(server, "root");
  const other = await signIn(server, "other");

  const mine = await post(server, "/issues", { cookie: root, key: "shared", body: ISSUE });
  const theirs = await post(server, "/issues", { cookie: other, key: "shared", body: ISSUE });

  // AC6: scoped to (actor_id, key). Otherwise one agent's choice of key would
  // silently swallow another's request.
  assert.equal(theirs.status, 201);
  assert.notEqual(theirs.json.key, mine.json.key);
  assert.equal(issueFiles(sandbox).length, 2);
});

// ── refusals (S3-D4) ────────────────────────────────────────────────────────

test("the same key with a different body is refused, not silently dropped", async (t) => {
  const sandbox = makeSandbox(t);
  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  t.after(() => server.close());
  const cookie = await signIn(server, "root");

  await post(server, "/issues", { cookie, key: "K", body: ISSUE });
  const different = await post(server, "/issues", {
    cookie, key: "K", body: { ...ISSUE, title: "전혀 다른 제목" },
  });

  // Replaying the first response would tell this caller it succeeded while
  // throwing its request away. The client is wrong and has to hear so.
  assert.equal(different.status, 409);
  assert.equal(different.json.error?.code, "E_IDEMPOTENCY_KEY_REUSED");
  assert.equal(issueFiles(sandbox).length, 1);
});

test("the same body spelled differently is still the same request", async (t) => {
  const sandbox = makeSandbox(t);
  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  t.after(() => server.close());
  const cookie = await signIn(server, "root");

  const first = await post(server, "/issues", {
    cookie, key: "K", body: { project: "LJ", type: "task", title: "같은 것" },
  });
  // Canonical JSON, so key order is not a difference. A hash of the raw bytes
  // would make every client's serialiser part of the contract.
  const reordered = await post(server, "/issues", {
    cookie, key: "K", body: { title: "같은 것", type: "task", project: "LJ" },
  });

  assert.equal(reordered.status, 201);
  assert.equal(reordered.body, first.body);
  assert.equal(issueFiles(sandbox).length, 1);
});

test("a malformed key is refused before anything is written", async (t) => {
  const sandbox = makeSandbox(t);
  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  t.after(() => server.close());
  const cookie = await signIn(server, "root");

  for (const key of ["", "x".repeat(256)]) {
    const response = await post(server, "/issues", { cookie, key, body: ISSUE });
    assert.equal(response.status, 400, `"${key.slice(0, 12)}" should be refused`);
  }

  // A control byte cannot go through fetch — undici refuses to put one on the
  // wire — so the server's own check is only reachable from a raw socket. It
  // is still the server that has to refuse it, not the client library.
  const raw = await rawPost(server, "\u0001key", cookie);
  assert.match(raw, /^HTTP\/1\.1 400 /, raw.split("\r\n")[0]);

  assert.equal(issueFiles(sandbox).length, 0, "and nothing was created along the way");
});

/** One request written straight to the socket, so odd header bytes survive. */
function rawPost(server: RunningServer, key: string, cookie: string): Promise<string> {
  const url = new URL(server.url);
  const body = JSON.stringify(ISSUE);
  const request =
    "POST /issues HTTP/1.1\r\n" +
    `Host: ${url.host}\r\n` +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `Cookie: ${cookie}\r\n` +
    `Idempotency-Key: ${key}\r\n` +
    "Connection: close\r\n\r\n" +
    body;

  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => socket.write(request));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

test("a refused request gives the key back", async (t) => {
  const sandbox = makeSandbox(t);
  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  t.after(() => server.close());
  const cookie = await signIn(server, "root");

  const bad = await post(server, "/issues", {
    cookie, key: "K", body: { project: "LJ", type: "task", title: "" },
  });
  assert.equal(bad.status, 400);

  // Holding the key after a 400 would leave the caller unable to retry with a
  // corrected body — the key would be spent on a request that never happened.
  const fixed = await post(server, "/issues", { cookie, key: "K", body: ISSUE });
  assert.equal(fixed.status, 201, JSON.stringify(fixed.json));
});

// ── across a restart ────────────────────────────────────────────────────────

test("the record survives a restart", async (t) => {
  const sandbox = makeSandbox(t);
  const first = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  const cookie = await signIn(first, "root");
  const created = await post(first, "/issues", { cookie, key: "K", body: ISSUE });
  await first.close();

  // AC8: the record lives in `.local/outbox.sqlite`, not in memory.
  const second = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  t.after(() => second.close());
  const again = await post(second, "/issues", {
    cookie: await signIn(second, "root"), key: "K", body: ISSUE,
  });

  assert.equal(again.body, created.body);
  assert.equal(issueFiles(sandbox).length, 1);
});

test("a reservation that never reached the journal is released", async (t) => {
  const sandbox = makeSandbox(t);
  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  await server.close();

  // What a crash between reserving and writing leaves behind. Nothing was
  // written, so the key must be free rather than answering 409 forever.
  const outbox = new Outbox(sandbox.local);
  outbox.reserveIdempotency("root", "K", "somehash");
  outbox.close();

  const restarted = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  t.after(() => restarted.close());
  const response = await post(restarted, "/issues", {
    cookie: await signIn(restarted, "root"), key: "K", body: ISSUE,
  });
  assert.equal(response.status, 201);
});

test("the write path records which resource the key produced", async (t) => {
  const sandbox = makeSandbox(t);
  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  const cookie = await signIn(server, "root");
  const created = await post(server, "/issues", { cookie, key: "K", body: ISSUE });
  await server.close();

  // The test below can prove that a stored `target_path` is replayed, but not
  // that anything puts one there — it plants its own. This is the other half:
  // a real request through the real writer has to leave the link behind, or
  // AC10 rests on a fixture instead of on the code.
  const outbox = new Outbox(sandbox.local);
  try {
    const held = outbox.findIdempotency("root", "K")!;
    assert.equal(held.targetPath, `issues/LJ/${created.json.key}.md`);
  } finally {
    outbox.close();
  }
});

test("a reservation whose write landed answers from the resource, not twice", async (t) => {
  const sandbox = makeSandbox(t);
  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  const cookie = await signIn(server, "root");
  const created = await post(server, "/issues", { cookie, body: ISSUE });
  await server.close();

  // A crash after the write journal accepted the operation but before the
  // response was recorded: `target_path` is set, the body is not (AC10).
  const outbox = new Outbox(sandbox.local);
  outbox.reserveIdempotency("root", "K", fingerprint(ISSUE));
  outbox.noteIdempotencyTarget("root", "K", `issues/LJ/${created.json.key}.md`);
  outbox.close();

  const restarted = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  t.after(() => restarted.close());
  const retried = await post(restarted, "/issues", {
    cookie: await signIn(restarted, "root"), key: "K", body: ISSUE,
  });

  assert.equal(retried.status, 201);
  assert.equal(retried.json.key, created.json.key, "the same issue, not a second one");
  assert.equal(issueFiles(sandbox).length, 1);
});

// ── the window ──────────────────────────────────────────────────────────────

test("a key older than 24 hours is a new request", async (t) => {
  const sandbox = makeSandbox(t);
  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  t.after(() => server.close());
  const cookie = await signIn(server, "root");

  await post(server, "/issues", { cookie, key: "K", body: ISSUE });

  const outbox = new Outbox(sandbox.local);
  const claim = outbox.reserveIdempotency(
    "root", "K", "somehash",
    Date.now() + IDEMPOTENCY_TTL_MS + 1_000,
  );
  outbox.close();

  // AC9: past the window the key is no longer protected, so the record must
  // not stand in the way of the string being reused.
  assert.equal(claim.outcome, "claimed");
});

test("the store tells the four outcomes apart", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "localjira-outbox-"));
  const outbox = new Outbox(local);
  try {
    assert.equal(outbox.reserveIdempotency("a", "K", "h1").outcome, "claimed");
    assert.equal(outbox.reserveIdempotency("a", "K", "h1").outcome, "in_progress");
    assert.equal(outbox.reserveIdempotency("a", "K", "h2").outcome, "mismatch");
    assert.equal(outbox.reserveIdempotency("b", "K", "h1").outcome, "claimed");

    outbox.completeIdempotency("a", "K", { status: 201, body: "{}", etag: '"abc"' });
    const replay = outbox.reserveIdempotency("a", "K", "h1");
    assert.equal(replay.outcome, "replay");
    assert.equal(replay.outcome === "replay" && replay.held.status, 201);
  } finally {
    outbox.close();
    fs.rmSync(local, { recursive: true, force: true });
  }
});
