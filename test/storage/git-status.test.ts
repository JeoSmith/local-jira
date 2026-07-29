import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer, type RunningServer } from "../../src/server/http.ts";
import { gitStatus } from "../../src/storage/git-status.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

interface Session {
  server: RunningServer;
  cookie: string;
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-git-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "g@example.com"]);
  git(repo, ["config", "user.name", "Git"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]);
  cli(repo, ["admin", "create", "--id", "owner", "--name", "오너", "--password", PASSWORD]);

  const server = await startServer({ cwd: repo, port: 0, watch: false });
  t.after(() => server.close());
  const login = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "owner", password: PASSWORD }),
  });
  assert.equal(login.status, 200);

  return {
    server,
    cookie: (login.headers.get("set-cookie") ?? "").split(";")[0],
    repo,
    board: path.join(repo, ".localjira"),
  };
}

async function call(session: Session, method: string, route: string, body?: unknown) {
  const response = await fetch(`${session.server.url}${route}`, {
    method,
    headers: { "content-type": "application/json", cookie: session.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
  };
}

function commitBoard(session: Session): void {
  git(session.board, ["add", "-A"]);
  git(session.board, ["-c", "user.email=g@e.com", "-c", "user.name=G", "commit", "-qm", "state"]);
}

interface Status {
  available: boolean;
  pending: Array<{ path: string; kind: string; key: string | null }>;
  ahead: number | null;
  lastPushAt: string | null;
  remote: string | null;
  reason: string | null;
  recovery: string | null;
}

async function status(session: Session): Promise<Status> {
  const response = await call(session, "GET", "/git/status");
  assert.equal(response.status, 200);
  return response.json as unknown as Status;
}

test("creating an issue adds one to the count, committing takes it away", async (t) => {
  const session = await makeSession(t);
  commitBoard(session);
  assert.equal((await status(session)).pending.length, 0);

  const created = await call(session, "POST", "/issues", {
    project: "LJ", type: "task", title: "새 이슈",
  });
  const key = created.json.key as unknown as string;

  const after = await status(session);
  const issueFiles = after.pending.filter((file) => file.path.startsWith("issues/"));
  assert.equal(issueFiles.length, 1, JSON.stringify(after.pending));
  assert.equal(issueFiles[0].kind, "added");
  // The display key, so the list reads as issues rather than as paths.
  assert.equal(issueFiles[0].key, key);

  commitBoard(session);
  assert.equal((await status(session)).pending.length, 0);
});

test("added, modified and deleted are all counted, once per file", async (t) => {
  const session = await makeSession(t);
  const keys: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const created = await call(session, "POST", "/issues", {
      project: "LJ", type: "task", title: `이슈 ${index}`,
    });
    keys.push(created.json.key as unknown as string);
  }
  commitBoard(session);

  // Two edits to one file still count as one changed file: AC1 promises that
  // creating one issue shows up as one, and a hunk count would break that.
  const file = path.join(session.board, "issues", "LJ", `${keys[0]}.md`);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace(/^title: .*$/m, "title: 두 번 고침").replace(/^type: .*$/m, "type: bug"),
  );
  fs.rmSync(path.join(session.board, "issues", "LJ", `${keys[1]}.md`));
  await call(session, "POST", "/issues", { project: "LJ", type: "task", title: "새로 추가" });

  const kinds = (await status(session)).pending
    .filter((entry) => entry.path.startsWith("issues/"))
    .map((entry) => entry.kind)
    .sort();
  assert.deepEqual(kinds, ["added", "deleted", "modified"]);
});

test("index churn under .local/ never moves the badge", async (t) => {
  const session = await makeSession(t);
  await call(session, "POST", "/issues", { project: "LJ", type: "task", title: "이슈" });
  commitBoard(session);
  assert.equal((await status(session)).pending.length, 0);

  // A rebuild rewrites the index, the outbox and the runtime db. None of it is
  // tracked (§5.3), so none of it is a change a person has to commit.
  const rebuilt = await call(session, "POST", "/index/rebuild");
  assert.equal(rebuilt.status, 200);
  await call(session, "POST", "/index/verify");

  assert.equal((await status(session)).pending.length, 0);
});

test("editing the code tree does not move the badge", async (t) => {
  const session = await makeSession(t);
  commitBoard(session);

  fs.writeFileSync(path.join(session.repo, "README.md"), "# changed a lot\n");
  fs.writeFileSync(path.join(session.repo, "new-source.ts"), "export const x = 1;\n");

  // D1: the badge watches the data worktree. Counting code changes would make
  // it move whenever somebody edits the program.
  assert.equal((await status(session)).pending.length, 0);
});

test("committed but unpushed work is reported separately", async (t) => {
  const session = await makeSession(t);

  // A bare repository standing in for a remote — no network involved.
  const remote = path.join(path.dirname(session.repo), "remote.git");
  git(path.dirname(session.repo), ["init", "--bare", "-q", remote]);
  git(session.board, ["remote", "add", "origin", remote]);
  git(session.board, ["push", "-q", "-u", "origin", "HEAD"]);

  assert.equal((await status(session)).ahead, 0);

  await call(session, "POST", "/issues", { project: "LJ", type: "task", title: "커밋만 할 것" });
  commitBoard(session);

  const after = await status(session);
  // D5: backed up means committed *and* pushed. Someone who commits, sees zero
  // uncommitted and stops would believe their only copy is safe.
  assert.equal(after.pending.length, 0);
  assert.equal(after.ahead, 1);

  git(session.board, ["push", "-q"]);
  const pushed = await status(session);
  assert.equal(pushed.ahead, 0);
  assert.ok(pushed.lastPushAt, "and the push left a trace to show");
});

test("no remote is a state, not a failure", async (t) => {
  const session = await makeSession(t);
  const reported = await status(session);

  assert.equal(reported.available, true);
  assert.equal(reported.remote, null);
  assert.equal(reported.ahead, null, "nothing to be ahead of");
  assert.equal(reported.lastPushAt, null);
});

test("a missing worktree reports the recovery command and does not stop the board", async (t) => {
  const session = await makeSession(t);
  await call(session, "POST", "/issues", { project: "LJ", type: "task", title: "살아남을 이슈" });

  // What `git clean -xdff` or a stray `worktree remove` leaves behind.
  const broken = gitStatus(path.join(session.repo, "not-a-worktree"));
  assert.equal(broken.available, false);
  assert.match(String(broken.recovery), /git worktree add \.localjira localjira\/data/);
  assert.deepEqual(broken.pending, []);

  // And the board keeps working: the issues are files, and git being unable to
  // describe them changes nothing about reading them.
  const listed = await call(session, "GET", "/issues");
  assert.equal(listed.status, 200);
  assert.equal((listed.json as unknown as { issues: unknown[] }).issues.length, 1);
});

test("reading the status touches no network", async (t) => {
  const session = await makeSession(t);

  // An unreachable remote: if anything fetched, this would hang or fail rather
  // than answer. N4 says the tool works offline.
  git(session.board, ["remote", "add", "origin", "https://127.0.0.1:1/nope.git"]);

  const started = Date.now();
  const reported = await status(session);
  const elapsed = Date.now() - started;

  assert.equal(reported.available, true);
  assert.equal(reported.remote, "origin");
  assert.ok(elapsed < 3_000, `took ${elapsed}ms, which suggests it tried to reach the network`);
});

test("a rename shows its new name", async (t) => {
  const session = await makeSession(t);
  const created = await call(session, "POST", "/issues", {
    project: "LJ", type: "task", title: "이름 바뀔 것",
  });
  const key = created.json.key as unknown as string;
  commitBoard(session);

  git(session.board, ["mv", `issues/LJ/${key}.md`, "issues/LJ/LJ-99.md"]);

  const renamed = (await status(session)).pending.find((file) => file.kind === "renamed");
  assert.ok(renamed, JSON.stringify((await status(session)).pending));
  assert.equal(renamed.path, "issues/LJ/LJ-99.md", "the name it has now, not the one it had");
  assert.equal(renamed.key, "LJ-99");
});
