import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { trailersIn } from "../../src/domain/commits.ts";
import { startServer, type RunningServer } from "../../src/server/http.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

interface Session {
  server: RunningServer;
  repo: string;
  board: string;
  admin: string;
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

interface Result {
  status: number;
  json: Record<string, never>;
  etag: string | null;
}

async function call(
  s: Session,
  method: string,
  route: string,
  options: { body?: unknown; etag?: string } = {},
): Promise<Result> {
  const response = await fetch(`${s.server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: s.admin,
      ...(options.etag ? { "if-match": options.etag } : {}),
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

/** A commit on the *code* branch, which is the side D1 keeps separate. */
function commit(s: Session, message: string, file = "src.txt"): string {
  fs.appendFileSync(path.join(s.repo, file), `${message}\n`);
  git(s.repo, ["add", "-A"]);
  git(s.repo, ["commit", "-m", message]);
  return git(s.repo, ["rev-parse", "HEAD"]).trim();
}

async function session(t: {
  after: (fn: () => void | Promise<void>) => void;
}): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-cmt2-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "dev@example.com"]);
  git(repo, ["config", "user.name", "개발자"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
  assert.equal(
    cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]).status,
    0,
  );
  cli(repo, ["admin", "create", "--id", "root", "--name", "루트", "--password", PASSWORD]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const server = await startServer({ cwd: repo, port: 0, watch: false });
  t.after(() => server.close());
  const login = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "root", password: PASSWORD }),
  });

  return {
    server, repo,
    board: path.join(repo, ".localjira"),
    admin: (login.headers.get("set-cookie") ?? "").split(";")[0],
  };
}

async function anIssue(s: Session, title = "커밋이 붙을 일"): Promise<string> {
  const created = await call(s, "POST", "/issues", {
    body: { project: "LJ", type: "task", title },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.key as unknown as string;
}

async function scan(s: Session): Promise<Record<string, never>> {
  const done = await call(s, "POST", "/commits/scan");
  assert.equal(done.status, 200, JSON.stringify(done.json));
  return done.json;
}

async function linksOn(s: Session, key: string): Promise<Array<Record<string, unknown>>> {
  const found = await call(s, "GET", `/issues/${key}/commits`);
  assert.equal(found.status, 200, JSON.stringify(found.json));
  return found.json.commits as unknown as Array<Record<string, unknown>>;
}

/** Everything git can say about the code repository, for an unchanged check. */
function repoState(s: Session): string {
  return JSON.stringify({
    head: git(s.repo, ["rev-parse", "HEAD"]).trim(),
    log: git(s.repo, ["log", "--format=%H %s"]),
    status: git(s.repo, ["status", "--porcelain", "-uall"]),
    branches: git(s.repo, ["branch", "-a"]),
    tags: git(s.repo, ["tag"]),
  });
}

// ── parsing (S5-D3) ─────────────────────────────────────────────────────────

test("a trailer is a line, and prose is not a trailer", () => {
  assert.deepEqual(trailersIn("fix: thing\n\nIssue: LJ-1\n"), ["LJ-1"]);
  // Case-insensitive, because nobody remembers which the project chose.
  assert.deepEqual(trailersIn("x\n\nissue: LJ-2\n"), ["LJ-2"]);
  // Every line, not the first: one commit touching two issues is ordinary, and
  // reading only the first leaves the second writer with no explanation.
  assert.deepEqual(trailersIn("x\n\nIssue: LJ-1\nIssue: LJ-2\n"), ["LJ-1", "LJ-2"]);
  assert.deepEqual(trailersIn("x\n\nIssue: LJ-1\nIssue: LJ-1\n"), ["LJ-1"]);
  // A mention in the body is a story; the trailer is the intent.
  assert.deepEqual(trailersIn("LJ-9 관련해서 고쳤다\n\n본문에 LJ-8도 나온다\n"), []);
  assert.deepEqual(trailersIn("x\n\nSee also Issue: LJ-3 somewhere\n"), []);
});

// ── linking ─────────────────────────────────────────────────────────────────

test("a trailer puts the commit on the issue", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const sha = commit(s, `feat: 무언가 고침\n\nIssue: ${key}`);

  const result = await scan(s);
  assert.equal(result.linked, 1);

  const [link] = await linksOn(s, key);
  assert.equal(link.sha, sha);
  assert.equal(link.short, sha.slice(0, 7));
  assert.equal(link.author, "개발자");
  assert.ok(link.committed_at, "and when");
  // §5.1 keeps a run's own commits[] separate; §5.7 forbids treating a commit
  // author as an authenticated actor. `source` is how the two are told apart.
  assert.equal(link.source, "trailer");
});

test("the scan reads the code branch, not the board's", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);

  // A commit on the data worktree naming the issue. D1 puts board data on
  // `localjira/data`, and scanning it would link the board's own history.
  git(s.board, ["add", "-A"]);
  git(s.board, [
    "-c", "user.email=b@e.com", "-c", "user.name=B",
    "commit", "-qm", `chore: board state\n\nIssue: ${key}`,
  ]);

  const result = await scan(s);
  assert.equal(result.linked, 0, JSON.stringify(result));
  assert.equal((await linksOn(s, key)).length, 0);
});

test("a trailer written with an old key still lands", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);

  // What a rekey leaves behind (D3): the issue answers to both, and a commit
  // written before the rename must not go dead.
  const file = path.join(s.board, "issues", "LJ", `${key}.md`);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("former_keys: []", "former_keys: [LJ-97]"),
  );
  await call(s, "POST", "/index/rebuild");

  commit(s, `fix: 옛 키로 쓴 커밋\n\nIssue: LJ-97`);
  const result = await scan(s);
  assert.equal(result.linked, 1, JSON.stringify(result));

  const [link] = await linksOn(s, key);
  assert.equal(link.trailer_key, "LJ-97", "the trailer as written");
  assert.equal(link.issue, key, "resolved to the key it has now");
});

test("the issue holding a key now wins over one that used to", async (t) => {
  const s = await session(t);
  const owner = await anIssue(s, "지금 그 키를 가진 이슈");
  const former = await anIssue(s, "옛날에 그 키였던 이슈");

  const file = path.join(s.board, "issues", "LJ", `${former}.md`);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("former_keys: []", `former_keys: [${owner}]`),
  );
  await call(s, "POST", "/index/rebuild");

  commit(s, `fix: 누구에게 붙나\n\nIssue: ${owner}`);
  await scan(s);

  // AC25: whoever writes that key means the issue that answers to it today.
  assert.equal((await linksOn(s, owner)).length, 1);
  assert.equal((await linksOn(s, former)).length, 0);
});

test("scanning twice links once", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  commit(s, `feat: 한 번만\n\nIssue: ${key}`);

  await scan(s);
  await scan(s);
  await scan(s);

  assert.equal((await linksOn(s, key)).length, 1);
});

test("one commit can name two issues", async (t) => {
  const s = await session(t);
  const first = await anIssue(s, "첫 이슈");
  const second = await anIssue(s, "둘째 이슈");
  commit(s, `refactor: 둘 다 건드림\n\nIssue: ${first}\nIssue: ${second}`);

  const result = await scan(s);
  assert.equal(result.linked, 2);
  assert.equal((await linksOn(s, first)).length, 1);
  assert.equal((await linksOn(s, second)).length, 1);
});

// ── read-only (D4) ──────────────────────────────────────────────────────────

test("the scan changes nothing in the code repository", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  commit(s, `feat: x\n\nIssue: ${key}`);

  const before = repoState(s);
  await scan(s);
  await scan(s);
  const after = repoState(s);

  // D4: no commit, tag, branch or checkout. A tool that rewrites your
  // repository to record something is not recording, it is participating.
  assert.equal(after, before);
});

test("the scan changes no board file either", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  commit(s, `feat: x\n\nIssue: ${key}`);

  const issueFile = path.join(s.board, "issues", "LJ", `${key}.md`);
  const before = fs.readFileSync(issueFile);
  const beforeStatus = git(s.board, ["status", "--porcelain", "-uall"]);

  await scan(s);

  // S5-D1: links live in the index. In frontmatter, every scan would dirty the
  // tree, and D4 means a person would be committing changes they did not make.
  assert.deepEqual(fs.readFileSync(issueFile), before);

  // The scan records that it ran, which is one event file — and nothing else.
  const afterStatus = git(s.board, ["status", "--porcelain", "-uall"]);
  const added = afterStatus
    .split("\n")
    .filter((line) => line.trim() !== "" && !beforeStatus.includes(line));
  assert.equal(
    added.every((line) => line.includes("events/")),
    true,
    added.join(" | "),
  );
});

test("links come back from a rebuilt index, because git is the source", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  commit(s, `feat: x\n\nIssue: ${key}`);
  await scan(s);
  assert.equal((await linksOn(s, key)).length, 1);

  // The index is a cache here exactly as it is for issue files: throw it away,
  // scan again, same links (S5-D1).
  await call(s, "POST", "/index/rebuild");
  assert.equal((await linksOn(s, key)).length, 0, "the cache really was dropped");
  await scan(s);
  assert.equal((await linksOn(s, key)).length, 1, "and rebuilt from history");
});

// ── the awkward cases ───────────────────────────────────────────────────────

test("a trailer naming no issue waits instead of vanishing", async (t) => {
  const s = await session(t);
  commit(s, `feat: 아직 없는 이슈\n\nIssue: LJ-404`);

  const first = await scan(s);
  assert.equal(first.linked, 0);
  assert.equal(first.pending, 1);

  const waiting = await call(s, "GET", "/commits/pending");
  assert.equal((waiting.json.commits as unknown as unknown[]).length, 1);

  // S5-D4: writing the trailer before the issue exists is a plausible order,
  // and dropping it would mean it never gets another chance.
  const key = await anIssue(s);
  assert.equal(key, "LJ-1", "the next key minted is not LJ-404");
  const file = path.join(s.board, "issues", "LJ", `${key}.md`);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("former_keys: []", "former_keys: [LJ-404]"),
  );
  await call(s, "POST", "/index/rebuild");

  const second = await scan(s);
  assert.equal(second.linked, 1, JSON.stringify(second));
  assert.equal((await linksOn(s, key)).length, 1);
});

test("a commit that history no longer has is dropped", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  commit(s, `feat: 곧 사라질 커밋\n\nIssue: ${key}`);
  await scan(s);
  assert.equal((await linksOn(s, key)).length, 1);

  // An amend replaces the commit rather than editing it, so the old hash is
  // gone. Keeping the link would leave a reference nobody can look up.
  git(s.repo, ["commit", "--amend", "-m", `feat: 고쳐 쓴 메시지\n\nIssue: ${key}`]);
  const result = await scan(s);

  assert.equal(result.pruned, 1, JSON.stringify(result));
  const links = await linksOn(s, key);
  assert.equal(links.length, 1, "the new commit, not two");
  assert.equal(links[0].summary, "feat: 고쳐 쓴 메시지");
});

test("a quarantined issue holds its link until it is repaired", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  commit(s, `feat: x\n\nIssue: ${key}`);

  fs.appendFileSync(
    path.join(s.board, "issues", "LJ", `${key}.md`),
    "\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> z\n",
  );
  await call(s, "POST", "/index/rebuild");

  const result = await scan(s);
  // §5.6: a quarantined entity is not changed until it is repaired, and gaining
  // a link is a change. Reported so the person knows it is waiting, not lost.
  assert.equal(result.linked, 0, JSON.stringify(result));
  assert.deepEqual(result.held, [key]);
});

test("no git means one feature off, not a broken board", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);

  // What a tarball download looks like: files, no repository.
  fs.renameSync(path.join(s.repo, ".git"), path.join(s.repo, ".git-away"));
  try {
    const attempt = await call(s, "POST", "/commits/scan");
    assert.equal(attempt.status, 503);
    assert.equal(attempt.json.available, false);
    assert.ok(attempt.json.reason);

    // And the board still works.
    const listed = await call(s, "GET", "/issues");
    assert.equal(listed.status, 200);
    assert.equal((listed.json.issues as unknown as unknown[]).length, 1);
    assert.equal((await call(s, "GET", `/issues/${key}`)).status, 200);
  } finally {
    fs.renameSync(path.join(s.repo, ".git-away"), path.join(s.repo, ".git"));
  }
});

test("scanning is operating the board, so no token reaches it", async (t) => {
  const s = await session(t);
  cli(s.repo, [
    "admin", "create", "--id", "bot", "--name", "봇", "--password", PASSWORD, "--role", "agent",
  ]);
  const issued = await call(s, "POST", "/tokens", { body: { user: "bot" } });

  const attempt = await fetch(`${s.server.url}/commits/scan`, {
    method: "POST",
    headers: { authorization: `Bearer ${issued.json.token as unknown as string}` },
  });
  // The seven scopes cover using the board, not reading somebody's code
  // repository (S5-D2, §6.4).
  assert.equal(attempt.status, 403);
});

test("the scan is recorded once, as the system", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  for (let index = 0; index < 5; index += 1) {
    commit(s, `feat: ${index}\n\nIssue: ${key}`);
  }
  await scan(s);

  const root = path.join(s.board, "events");
  const events: Array<Record<string, unknown>> = [];
  for (const day of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, day))) {
      for (const line of fs.readFileSync(path.join(root, day, file), "utf8").split("\n")) {
        if (line.trim() !== "") {
          events.push(JSON.parse(line) as Record<string, unknown>);
        }
      }
    }
  }

  const scans = events.filter((event) => event.verb === "issue.changed_externally");
  // One line for the scan, not one per commit: five hundred links would
  // otherwise write five hundred lines saying the same thing.
  assert.equal(scans.length, 1, JSON.stringify(scans));
  // §5.7: the commit authors are not authenticated actors, so the actor is the
  // scan itself.
  assert.equal(scans[0].actor_kind, "system");
  assert.equal((scans[0].after as Record<string, unknown>).linked, 5);
});
