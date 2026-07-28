import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer, type RunningServer } from "../src/server/http.ts";

/**
 * Gate 1 of Sprint 01:
 *
 *   "an authenticated admin creates an issue, then the index is deleted and
 *    the server restarted, and the same issue comes back"
 *
 * r08a, r01a and r12a each pass on their own. This is the only test that runs
 * them as one path, which is what the gate actually asks for — the three
 * stories could each be correct while the seam between them is not.
 */

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout;
}

function cli(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `localjira ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

interface Client {
  cookie: string | null;
}

async function call(
  server: RunningServer,
  client: Client,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, never>; etag: string | null }> {
  const response = await fetch(`${server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(client.cookie ? { cookie: client.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    client.cookie = setCookie.split(";")[0];
  }

  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
    etag: response.headers.get("etag"),
  };
}

test("Gate 1: an issue survives losing the index", { timeout: 120_000 }, async (t) => {
  // ── a repository as a user would have it ──────────────────────────────────
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-gate1-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "gate1@example.com"]);
  git(repo, ["config", "user.name", "Gate One"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  const board = path.join(repo, ".localjira");

  // ── 1. board bootstrap ────────────────────────────────────────────────────
  cli(repo, [
    "init", "--project-key", "LJ", "--project-name", "Local Jira", "--timezone", "Asia/Seoul",
  ]);
  assert.equal(git(board, ["rev-parse", "--abbrev-ref", "HEAD"]), "localjira/data\n");

  // ── 2. first admin ────────────────────────────────────────────────────────
  cli(repo, ["admin", "create", "--id", "admin", "--name", "관리자", "--password", PASSWORD]);

  // ── 3. sign in and create an issue over HTTP ──────────────────────────────
  const client: Client = { cookie: null };
  let created: Awaited<ReturnType<typeof call>>;

  const first = await startServer({ cwd: repo, port: 0 });
  try {
    const anonymous = await call(first, { cookie: null }, "GET", "/issues");
    assert.equal(anonymous.status, 401, "the API must be closed before signing in");

    const login = await call(first, client, "POST", "/auth/login", {
      id: "admin",
      password: PASSWORD,
    });
    assert.equal(login.status, 200);
    assert.ok(client.cookie);

    created = await call(first, client, "POST", "/issues", {
      project: "LJ",
      type: "story",
      title: "게이트 1을 통과하는 이슈",
      description: "본문은 파일 그대로 남는다.",
      points: 5,
      labels: ["core", "storage"],
      acceptance: ["인덱스를 지워도 같은 내용이 돌아온다"],
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.issue.key, "LJ-1");
    assert.match(created.etag ?? "", /^"[0-9a-f]{64}"$/);
  } finally {
    await first.close();
  }

  // ── 4. the file is the issue ──────────────────────────────────────────────
  const issueFile = path.join(board, "issues", "LJ", "LJ-1.md");
  const fileBefore = fs.readFileSync(issueFile, "utf8");
  assert.match(fileBefore, /^key: LJ-1$/m);
  assert.match(fileBefore, /^status: BACKLOG$/m);
  assert.match(fileBefore, /본문은 파일 그대로 남는다\./);

  // The account, the issue and its event belong to the board. Everything the
  // server built for itself — index, outbox, sessions, credentials — lives
  // under .local/ and never reaches git.
  const tracked = git(board, ["status", "--porcelain", "-uall"]).split("\n").filter(Boolean).sort();
  assert.deepEqual(
    tracked.map((line) => line.replace(/events\/[^ ]+$/, "events/…")),
    [" M users.yaml", "?? events/…", "?? issues/LJ/LJ-1.md"],
  );
  assert.equal(tracked.some((line) => line.includes(".local")), false);

  // ── 5. lose the index ─────────────────────────────────────────────────────
  const indexFile = path.join(board, ".local", "index.sqlite");
  assert.equal(fs.existsSync(indexFile), true);
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${indexFile}${suffix}`, { force: true });
  }

  // ── 6. restart and read it back ───────────────────────────────────────────
  const second = await startServer({ cwd: repo, port: 0 });
  try {
    // The session outlives the index: it lives in credentials.sqlite, which is
    // a different concern with a different lifetime.
    const shown = await call(second, client, "GET", "/issues/LJ-1");

    assert.equal(shown.status, 200, "the issue must come back from the file alone");
    assert.equal(
      shown.etag,
      created.etag,
      "a rebuilt index must produce the same representation, byte for byte",
    );
    assert.deepEqual(
      shown.json.issue,
      created.json.issue,
      "every field, not just the ones the test happens to name",
    );

    const listed = await call(second, client, "GET", "/issues");
    assert.equal(listed.json.issues.length, 1);
    assert.equal(listed.json.issues[0].title, "게이트 1을 통과하는 이슈");
  } finally {
    await second.close();
  }

  // ── 7. the rebuild changed nothing on disk ────────────────────────────────
  assert.equal(fs.readFileSync(issueFile, "utf8"), fileBefore, "rebuilding must not touch files");
  assert.deepEqual(
    git(board, ["status", "--porcelain", "-uall"]).split("\n").filter(Boolean).sort(),
    tracked,
    "and must not add anything git can see",
  );

  // ── 8. the CLI sees the same board ────────────────────────────────────────
  const listed = cli(repo, ["issue", "list", "--json"]);
  const issues = JSON.parse(listed.stdout) as Array<{ key: string; points: number; labels: string[] }>;
  assert.deepEqual(issues.map((issue) => issue.key), ["LJ-1"]);
  assert.equal(issues[0].points, 5);
  assert.deepEqual(issues[0].labels, ["core", "storage"]);

  const status = cli(repo, ["index", "status", "--json"]);
  const health = JSON.parse(status.stdout) as { counts: Record<string, number>; errors: unknown[] };
  assert.equal(health.counts.issues, 1);
  assert.deepEqual(health.errors, []);
});
