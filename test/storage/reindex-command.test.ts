import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer, type RunningServer } from "../../src/server/http.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

interface Session {
  server: RunningServer;
  admin: string;
  member: string;
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
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

async function makeSession(t: { after: (fn: () => void) => void }): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-reindex-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "x@example.com"]);
  git(repo, ["config", "user.name", "Reindex"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]);
  cli(repo, ["admin", "create", "--id", "owner", "--name", "관리자", "--password", PASSWORD]);
  cli(repo, ["admin", "create", "--id", "dev", "--name", "개발자", "--password", PASSWORD, "--role", "member"]);

  const server = await startServer({ cwd: repo, port: 0, watch: false });
  t.after(() => server.close());

  const signIn = async (id: string): Promise<string> => {
    const login = await fetch(`${server.url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, password: PASSWORD }),
    });
    assert.equal(login.status, 200, `${id} could not sign in`);
    return (login.headers.get("set-cookie") ?? "").split(";")[0];
  };

  return {
    server,
    admin: await signIn("owner"),
    member: await signIn("dev"),
    repo,
    board: path.join(repo, ".localjira"),
  };
}

async function call(
  session: Session,
  method: string,
  route: string,
  options: { as?: string; body?: unknown; ifMatch?: string } = {},
) {
  const response = await fetch(`${session.server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: options.as ?? session.admin,
      ...(options.ifMatch === undefined ? {} : { "if-match": options.ifMatch }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    retryAfter: response.headers.get("retry-after"),
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
  };
}

async function make(session: Session, title: string): Promise<string> {
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title, points: 3 },
  });
  assert.equal(created.status, 201);
  return created.json.key as unknown as string;
}

test("a rebuild leaves the answers identical and the working tree clean", async (t) => {
  const session = await makeSession(t);
  for (const title of ["첫째", "둘째", "셋째"]) {
    await make(session, title);
  }

  const before = await call(session, "GET", "/issues");
  git(session.board, ["add", "-A"]);
  git(session.board, ["-c", "user.email=x@e.com", "-c", "user.name=X", "commit", "-qm", "state"]);

  const rebuilt = await call(session, "POST", "/index/rebuild");
  assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.json));
  assert.equal(rebuilt.json.unchanged as unknown as boolean, true);

  // AC2: the index is derived, so rebuilding it may not change an answer.
  const after = await call(session, "GET", "/issues");
  assert.deepEqual(after.json.issues, before.json.issues);

  // …and it must not have touched a single domain file doing it.
  assert.equal(git(session.board, ["status", "--porcelain"]).trim(), "");
});

test("verify catches a file whose content changed but whose stat fields did not", async (t) => {
  const session = await makeSession(t);
  const key = await make(session, "몰래 바뀔 이슈");

  const file = path.join(session.board, "issues", "LJ", `${key}.md`);
  const stat = fs.statSync(file);
  const original = fs.readFileSync(file, "utf8");

  // Same length, same mtime, different bytes — the exact case the metadata
  // fast path is allowed to miss and a verification is not.
  const swapped = original.replace(/^title: .*$/m, `title: ${"X".repeat("몰래 바뀔 이슈".length)}`);
  assert.notEqual(swapped, original);
  fs.writeFileSync(file, swapped);
  fs.utimesSync(file, stat.atime, stat.mtime);

  const verified = await call(session, "POST", "/index/verify", { as: session.member });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));

  const shown = await call(session, "GET", `/issues/${key}`);
  assert.equal(
    (shown.json as unknown as { title: string }).title,
    "X".repeat("몰래 바뀔 이슈".length),
    "the verification noticed a change the stat fields hid",
  );
  // And it read the file rather than rewriting it: verification is a read.
  assert.equal(fs.readFileSync(file, "utf8"), swapped);
});

test("a rebuild is admin only; a verification is not", async (t) => {
  const session = await makeSession(t);
  await make(session, "이슈");

  // 설계 §3.7: a rebuild swaps the index generation and pauses writes, which is
  // an operational act. A verification only reads and reports.
  const memberRebuild = await call(session, "POST", "/index/rebuild", { as: session.member });
  assert.equal(memberRebuild.status, 403);

  const memberVerify = await call(session, "POST", "/index/verify", { as: session.member });
  assert.equal(memberVerify.status, 200);

  const adminRebuild = await call(session, "POST", "/index/rebuild");
  assert.equal(adminRebuild.status, 200);
});

test("neither command adds a domain event", async (t) => {
  const session = await makeSession(t);
  const key = await make(session, "이력 확인용");

  const before = await call(session, "GET", `/issues/${key}/activity`);
  const count = (before.json as unknown as { entries: unknown[] }).entries.length;

  await call(session, "POST", "/index/verify");
  await call(session, "POST", "/index/rebuild");

  const after = await call(session, "GET", `/issues/${key}/activity`);
  // The index is derived; regenerating it is not something that happened to
  // the issue, and a timeline that says otherwise is lying.
  assert.equal((after.json as unknown as { entries: unknown[] }).entries.length, count);
});

test("the index report says what is running and what was found", async (t) => {
  const session = await makeSession(t);
  await make(session, "이슈");

  const idle = await call(session, "GET", "/index");
  assert.equal(idle.json.running as unknown as string | null, null);
  assert.equal((idle.json as unknown as { counts: { issues: number } }).counts.issues, 1);

  fs.writeFileSync(
    path.join(session.board, "issues", "LJ", "LJ-99.md"),
    "---\nuid: [unclosed\n---\n",
  );
  await call(session, "POST", "/index/verify");

  const afterBreak = await call(session, "GET", "/index");
  assert.equal(afterBreak.json.quarantined as unknown as number, 1);
  assert.ok(afterBreak.json.lastVerifyAt, "the run is recorded for the settings screen");
});

test("five thousand files rebuild inside the budget", { timeout: 180_000 }, async (t) => {
  const session = await makeSession(t);
  const directory = path.join(session.board, "issues", "LJ");
  fs.mkdirSync(directory, { recursive: true });

  for (let index = 1; index <= 5_000; index += 1) {
    fs.writeFileSync(
      path.join(directory, `LJ-${index + 100}.md`),
      `---\nuid: 01JBULK${String(index).padStart(19, "0")}\nkey: LJ-${index + 100}\n` +
        `type: task\ntitle: 대량 ${index}\nstatus: BACKLOG\nbacklog_rank: "${String(index).padStart(6, "0")}"\n---\n\n`,
    );
  }

  const rebuilt = await call(session, "POST", "/index/rebuild");
  assert.equal(rebuilt.status, 200);
  const duration = rebuilt.json.durationMs as unknown as number;

  // N2 allows 10s for a 5,000-file rebuild.
  assert.ok(duration < 10_000, `rebuild took ${duration}ms against a 10,000ms budget (N2)`);
  process.stdout.write(`      (5,000 files rebuilt in ${duration}ms)\n`);
});
