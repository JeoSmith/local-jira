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
  cookie: string;
  repo: string;
  board: string;
  restart(): Promise<void>;
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-rekey-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "k@example.com"]);
  git(repo, ["config", "user.name", "Rekey"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]);
  cli(repo, ["admin", "create", "--id", "owner", "--name", "오너", "--password", PASSWORD]);

  const session = { repo, board: path.join(repo, ".localjira") } as Session;
  const boot = async (): Promise<void> => {
    session.server = await startServer({ cwd: repo, port: 0, watch: false });
    const login = await fetch(`${session.server.url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "owner", password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    session.cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  };
  session.restart = async () => {
    await session.server.close();
    await boot();
  };

  await boot();
  t.after(() => session.server.close());
  return session;
}

async function call(session: Session, method: string, route: string) {
  const response = await fetch(`${session.server.url}${route}`, {
    method,
    headers: { "content-type": "application/json", cookie: session.cookie },
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
  };
}

/** An issue file as another clone would have written it, offline. */
function writeIssue(session: Session, key: string, uid: string, title: string): void {
  fs.mkdirSync(path.join(session.board, "issues", "LJ"), { recursive: true });
  fs.writeFileSync(
    path.join(session.board, "issues", "LJ", `${key}.md`),
    `---\nuid: ${uid}\nkey: ${key}\nformer_keys: []\ntype: task\ntitle: ${title}\n` +
      `status: BACKLOG\nbacklog_rank: "${uid.slice(0, 6)}"\n---\n\n`,
  );
}

const EARLY = "01J000000000000000000000AA";
const LATER = "01J111111111111111111111BB";
const LATEST = "01J222222222222222222222CC";

test("the later creation moves, the earlier one keeps its key", async (t) => {
  const session = await makeSession(t);
  await session.server.close();

  // Two clones each made LJ-13 offline; the merge brought both files in.
  writeIssue(session, "LJ-13", EARLY, "먼저 만든 것");
  fs.writeFileSync(
    path.join(session.board, "issues", "LJ", "LJ-13-b.md"),
    `---\nuid: ${LATER}\nkey: LJ-13\nformer_keys: []\ntype: task\ntitle: 나중에 만든 것\nstatus: BACKLOG\n---\n\n`,
  );
  await session.restart();

  const original = await call(session, "GET", "/issues/LJ-13");
  assert.equal(original.status, 200);
  assert.equal(
    (original.json as unknown as { uid: string }).uid,
    EARLY,
    "the earlier ULID keeps the key it was created with (D3)",
  );

  const moved = await call(session, "GET", "/issues/LJ-14");
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal((moved.json as unknown as { uid: string }).uid, LATER);

  // Its uid did not change — that is what keeps every parent, link and event
  // pointing at the same entity through a rekey.
  const file = fs.readFileSync(
    path.join(session.board, "issues", "LJ", "LJ-13-b.md"),
    "utf8",
  );
  assert.match(file, new RegExp(`uid: ${LATER}`));
  assert.match(file, /^key: LJ-14$/m);
  assert.match(file, /^former_keys: \[LJ-13\]$/m);
});

test("two clones reconciling the same merge reach the same answer", async (t) => {
  const first = await makeSession(t);
  const second = await makeSession(t);

  // Identical merged trees, reconciled independently with nothing between them.
  for (const session of [first, second]) {
    await session.server.close();
    writeIssue(session, "LJ-13", EARLY, "A");
    fs.writeFileSync(
      path.join(session.board, "issues", "LJ", "LJ-13-dup.md"),
      `---\nuid: ${LATER}\nkey: LJ-13\nformer_keys: []\ntype: task\ntitle: B\nstatus: BACKLOG\n---\n\n`,
    );
    fs.writeFileSync(
      path.join(session.board, "issues", "LJ", "LJ-20-dup.md"),
      `---\nuid: ${LATEST}\nkey: LJ-20\nformer_keys: []\ntype: task\ntitle: C\nstatus: BACKLOG\n---\n\n`,
    );
    writeIssue(session, "LJ-20", EARLY.replace("AA", "DD"), "D");
    await session.restart();
  }

  const keysOf = async (session: Session): Promise<Array<[string, string]>> => {
    const listed = await call(session, "GET", "/issues?limit=100");
    return (listed.json as unknown as { issues: Array<{ uid: string; key: string }> }).issues
      .map((issue): [string, string] => [issue.uid, issue.key])
      .sort((a, b) => a[0].localeCompare(b[0]));
  };

  // The claim D3 makes: convergence without a coordinator.
  assert.deepEqual(await keysOf(second), await keysOf(first));
});

test("the old key still finds the issue, and says where it went", async (t) => {
  const session = await makeSession(t);
  await session.server.close();

  writeIssue(session, "LJ-13", EARLY, "원 소유자");
  fs.writeFileSync(
    path.join(session.board, "issues", "LJ", "LJ-13-b.md"),
    `---\nuid: ${LATER}\nkey: LJ-13\nformer_keys: []\ntype: task\ntitle: 밀려난 것\nstatus: BACKLOG\n---\n\n`,
  );
  await session.restart();

  // While somebody still holds LJ-13 as a current key, that wins outright —
  // a single-resource lookup must not turn into a list of maybes.
  const current = await call(session, "GET", "/issues/LJ-13");
  assert.equal((current.json as unknown as { uid: string }).uid, EARLY);

  // Now free the old key entirely and the alias becomes the only answer.
  fs.rmSync(path.join(session.board, "issues", "LJ", "LJ-13.md"));
  await session.server.reconcile();

  const viaAlias = await call(session, "GET", "/issues/LJ-13");
  assert.equal(viaAlias.status, 200, JSON.stringify(viaAlias.json));
  assert.equal((viaAlias.json as unknown as { uid: string }).uid, LATER);
  assert.equal(
    (viaAlias.json as unknown as { key: string }).key,
    "LJ-14",
    "the response carries the key it lives under now",
  );
});

test("a rekey is recorded as the board's own doing", async (t) => {
  const session = await makeSession(t);
  await session.server.close();

  writeIssue(session, "LJ-13", EARLY, "원본");
  fs.writeFileSync(
    path.join(session.board, "issues", "LJ", "LJ-13-b.md"),
    `---\nuid: ${LATER}\nkey: LJ-13\nformer_keys: []\ntype: task\ntitle: 밀려난 것\nstatus: BACKLOG\n---\n\n`,
  );
  await session.restart();

  const timeline = await call(session, "GET", "/issues/LJ-14/activity");
  const entries = (timeline.json as unknown as {
    entries: Array<{ verb: string; actor: { kind: string; id: string | null }; before: unknown; after: unknown }>;
  }).entries;

  const rekey = entries.find((entry) => entry.verb === "issue.rekeyed");
  assert.ok(rekey, `no rekey event in ${JSON.stringify(entries.map((e) => e.verb))}`);
  // Nobody asked for this; the board did it. Attributing it to a person would
  // put a change in their name that they never made (AC25).
  assert.equal(rekey.actor.kind, "system");
  assert.equal(rekey.actor.id, null);
  assert.deepEqual(rekey.before, { key: "LJ-13" });
  assert.deepEqual(rekey.after, { key: "LJ-14" });
});

test("reconciling again does not push the key along a second time", async (t) => {
  const session = await makeSession(t);
  await session.server.close();

  writeIssue(session, "LJ-13", EARLY, "원본");
  fs.writeFileSync(
    path.join(session.board, "issues", "LJ", "LJ-13-b.md"),
    `---\nuid: ${LATER}\nkey: LJ-13\nformer_keys: []\ntype: task\ntitle: 밀려난 것\nstatus: BACKLOG\n---\n\n`,
  );
  await session.restart();

  const after = await call(session, "GET", "/issues/LJ-14");
  assert.equal(after.status, 200);

  // The plan is recomputed from the files every pass, so it has to be a no-op
  // once applied — otherwise a crash mid-rekey would ratchet keys upward.
  for (let pass = 0; pass < 3; pass += 1) {
    await session.server.reconcile();
  }

  const stable = await call(session, "GET", "/issues/LJ-14");
  assert.equal(stable.status, 200, "the key stayed put across three reconciles");
  assert.equal((stable.json as unknown as { uid: string }).uid, LATER);
  assert.equal((await call(session, "GET", "/issues/LJ-15")).status, 404);
});

test("a duplicate uid is quarantined, not rekeyed", async (t) => {
  const session = await makeSession(t);
  await session.server.close();

  // Same uid in two files is a different problem: the identity is ambiguous,
  // so there is no "later one" to move (R11, D3).
  writeIssue(session, "LJ-30", EARLY, "A");
  fs.writeFileSync(
    path.join(session.board, "issues", "LJ", "LJ-31.md"),
    `---\nuid: ${EARLY}\nkey: LJ-31\nformer_keys: []\ntype: task\ntitle: B\nstatus: BACKLOG\n---\n\n`,
  );
  await session.restart();

  const quarantined = await call(session, "GET", "/integrity/issues");
  const reasons = (quarantined.json as unknown as {
    quarantined: Array<{ reason: string }>;
  }).quarantined.map((entry) => entry.reason);

  assert.deepEqual(reasons.sort(), ["duplicate_uid", "duplicate_uid"]);
});

test("a rekey shows up as an uncommitted change and nothing else", async (t) => {
  const session = await makeSession(t);
  await session.server.close();

  writeIssue(session, "LJ-13", EARLY, "원본");
  fs.writeFileSync(
    path.join(session.board, "issues", "LJ", "LJ-13-b.md"),
    `---\nuid: ${LATER}\nkey: LJ-13\nformer_keys: []\ntype: task\ntitle: 밀려난 것\nstatus: BACKLOG\n---\n\n`,
  );
  git(session.board, ["add", "-A"]);
  git(session.board, ["-c", "user.email=k@e.com", "-c", "user.name=K", "commit", "-qm", "merged"]);
  await session.restart();

  // D4: the service never commits or pushes. The change is left visible so a
  // person decides when it goes in.
  const status = git(session.board, ["status", "--porcelain"]);
  assert.match(status, /LJ-13-b\.md/, "the rekeyed file is left modified");
  assert.doesNotMatch(status, /LJ-13\.md/, "and only that file was touched");
});
