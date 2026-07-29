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

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
}

function cli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

async function makeSession(t: { after: (fn: () => void) => void }): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-integrity-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "i@example.com"]);
  git(repo, ["config", "user.name", "Integrity"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]);
  cli(repo, ["admin", "create", "--id", "owner", "--name", "오너", "--password", PASSWORD]);

  const session = {
    repo,
    board: path.join(repo, ".localjira"),
  } as Session;

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
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
  };
}

interface Made {
  key: string;
  uid: string;
  etag: string;
}

async function make(session: Session, title: string, type = "task"): Promise<Made> {
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type, title },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return {
    key: created.json.key as unknown as string,
    uid: created.json.uid as unknown as string,
    etag: created.etag ?? "",
  };
}

function issueFile(session: Session, key: string): string {
  return path.join(session.board, "issues", "LJ", `${key}.md`);
}

interface Quarantined {
  path: string;
  key: string | null;
  reason: string;
  detail: string | null;
  lastGoodHash: string | null;
}

async function quarantined(session: Session): Promise<Quarantined[]> {
  const listed = await call(session, "GET", "/integrity/issues");
  assert.equal(listed.status, 200);
  return (listed.json as unknown as { quarantined: Quarantined[] }).quarantined;
}

async function keys(session: Session): Promise<string[]> {
  const listed = await call(session, "GET", "/issues?limit=500");
  return (listed.json as unknown as { issues: Array<{ key: string }> }).issues.map((i) => i.key);
}

test("a broken file is hidden, not deleted, and the rest of the board works", async (t) => {
  const session = await makeSession(t);
  const broken = await make(session, "깨질 이슈");
  const healthy = await make(session, "멀쩡한 이슈");

  fs.writeFileSync(issueFile(session, broken.key), "---\nuid: [unclosed\nkey: oops\n---\n");
  await session.server.reconcile();

  assert.deepEqual(await keys(session), [healthy.key], "the broken one is out of the list");

  const records = await quarantined(session);
  const record = records.find((entry) => entry.path.endsWith(`${broken.key}.md`));
  assert.ok(record, "and is reported instead of vanishing");
  assert.ok(record.lastGoodHash, "the last good version is remembered");

  // The rest of the board carries on: this is the whole point (AC10).
  const stillWorks = await call(session, "PUT", `/issues/${healthy.key}`, {
    ifMatch: (await call(session, "GET", `/issues/${healthy.key}`)).etag ?? "",
    body: { points: 5 },
  });
  assert.equal(stillWorks.status, 200);
  assert.equal((await make(session, "새로 만드는 것")).key.startsWith("LJ-"), true);
});

test("a conflict marker is diagnosed as itself, not as a parse error", async (t) => {
  const session = await makeSession(t);
  const conflicted = await make(session, "머지 사고");

  const original = fs.readFileSync(issueFile(session, conflicted.key), "utf8");
  fs.writeFileSync(
    issueFile(session, conflicted.key),
    original.replace(
      /^title: .*$/m,
      "<<<<<<< HEAD\ntitle: 내 쪽 제목\n=======\ntitle: 남의 제목\n>>>>>>> theirs",
    ),
  );
  await session.server.reconcile();

  const record = (await quarantined(session)).find((entry) =>
    entry.path.endsWith(`${conflicted.key}.md`),
  );
  assert.equal(record?.reason, "conflict_marker");
  // "Finish the merge" is the whole diagnosis; a parser complaint about line 6
  // would be accurate and useless.
  assert.match(String(record?.detail), /unresolved git conflict marker/i);
});

test("two files claiming one uid quarantine both, because neither is obviously right", async (t) => {
  const session = await makeSession(t);
  const original = await make(session, "원본");
  await session.server.close();

  // A merge that brought the same issue in twice under different names.
  const copy = path.join(session.board, "issues", "LJ", "LJ-77.md");
  fs.writeFileSync(
    copy,
    fs.readFileSync(issueFile(session, original.key), "utf8").replace(/^key: .*$/m, "key: LJ-77"),
  );
  await session.restart();

  const records = await quarantined(session);
  const duplicates = records.filter((entry) => entry.reason === "duplicate_uid");
  assert.equal(duplicates.length, 2, "both sides, since picking one would discard work");
  assert.deepEqual(
    duplicates.map((entry) => entry.path).sort(),
    [`issues/LJ/${original.key}.md`, "issues/LJ/LJ-77.md"].sort(),
  );
  assert.match(String(duplicates[0].detail), new RegExp(original.uid));
});

test("a dangling parent is quarantined with a way out", async (t) => {
  const session = await makeSession(t);
  const epic = await make(session, "에픽", "epic");
  const child = await make(session, "자식", "story");
  await call(session, "PUT", `/issues/${child.key}`, {
    ifMatch: (await call(session, "GET", `/issues/${child.key}`)).etag ?? "",
    body: { parent: epic.uid },
  });

  await session.server.close();
  fs.rmSync(issueFile(session, epic.key));
  await session.restart();

  const record = (await quarantined(session)).find((entry) =>
    entry.path.endsWith(`${child.key}.md`),
  );
  assert.equal(record?.reason, "dangling_ref");
  assert.match(String(record?.detail), /Remove the parent to make it top level/);
});

test("a parent cycle quarantines every issue in the loop", async (t) => {
  const session = await makeSession(t);
  const first = await make(session, "A", "story");
  const second = await make(session, "B", "story");
  await session.server.close();

  // Only a merge or a hand edit can produce this: the API's type rules forbid
  // a story under a story, which is exactly why the check lives here too.
  const point = (key: string, uid: string): void => {
    const file = issueFile(session, key);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace(/^status: /m, `parent: ${uid}\nstatus: `),
    );
  };
  point(first.key, second.uid);
  point(second.key, first.uid);
  await session.restart();

  const cycles = (await quarantined(session)).filter((entry) => entry.reason === "cycle");
  assert.equal(cycles.length, 2, "both, because no single link is the wrong one");
  assert.match(String(cycles[0].detail), /forms a loop/);
});

test("a quarantined issue refuses changes and says how to fix it", async (t) => {
  const session = await makeSession(t);
  const broken = await make(session, "고장날 이슈");
  const other = await make(session, "정상");

  const held = (await call(session, "GET", `/issues/${broken.key}`)).etag ?? "";
  fs.writeFileSync(issueFile(session, broken.key), "---\nuid: [unclosed\n---\n");
  await session.server.reconcile();

  for (const attempt of [
    () => call(session, "PUT", `/issues/${broken.key}`, { ifMatch: held, body: { points: 1 } }),
    () =>
      call(session, "POST", `/issues/${broken.key}/transitions`, {
        ifMatch: held,
        body: { to: "TODO" },
      }),
    () => call(session, "DELETE", `/issues/${broken.key}`, { ifMatch: held }),
  ]) {
    const refused = await attempt();
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    const body = refused.json as unknown as {
      error: { code: string };
      reason: string;
      path: string;
    };
    assert.equal(body.error.code, "E_ISSUE_QUARANTINED");
    assert.ok(body.reason, "the quarantine type is named");
    assert.match(body.path, /issues\/LJ\//, "and so is the file to repair");
  }

  // An issue that does not reference the broken one is unaffected.
  const fine = await call(session, "PUT", `/issues/${other.key}`, {
    ifMatch: (await call(session, "GET", `/issues/${other.key}`)).etag ?? "",
    body: { points: 3 },
  });
  assert.equal(fine.status, 200);
});

test("linking to a quarantined issue is refused", async (t) => {
  const session = await makeSession(t);
  const broken = await make(session, "고장날 것");
  const healthy = await make(session, "멀쩡한 것");

  fs.writeFileSync(issueFile(session, broken.key), "---\nuid: [unclosed\n---\n");
  await session.server.reconcile();

  const refused = await call(session, "POST", `/issues/${healthy.key}/links`, {
    ifMatch: (await call(session, "GET", `/issues/${healthy.key}`)).etag ?? "",
    body: { kind: "blocked_by", to: broken.uid },
  });
  // Building on an entity the board cannot vouch for would just spread it.
  assert.equal(refused.status, 409);
  assert.equal(
    (refused.json as unknown as { error: { code: string } }).error.code,
    "E_ISSUE_QUARANTINED",
  );
});

test("repairing the file releases the quarantine on the next reconcile", async (t) => {
  const session = await makeSession(t);
  const broken = await make(session, "고쳐질 이슈");
  const good = fs.readFileSync(issueFile(session, broken.key), "utf8");

  fs.writeFileSync(issueFile(session, broken.key), "---\nuid: [unclosed\n---\n");
  await session.server.reconcile();
  assert.equal((await keys(session)).includes(broken.key), false);

  // The recovery is a person fixing the file; nothing here repairs it for them.
  fs.writeFileSync(issueFile(session, broken.key), good);
  await session.server.reconcile();

  assert.equal((await keys(session)).includes(broken.key), true, "back on the board");
  assert.deepEqual(await quarantined(session), [], "and out of the error list");

  const writable = await call(session, "PUT", `/issues/${broken.key}`, {
    ifMatch: (await call(session, "GET", `/issues/${broken.key}`)).etag ?? "",
    body: { points: 2 },
  });
  assert.equal(writable.status, 200, "the block is lifted too");
});

test("duplicate ranks are ordered, not quarantined", async (t) => {
  const session = await makeSession(t);
  const first = await make(session, "A");
  const second = await make(session, "B");
  await session.server.close();

  for (const key of [first.key, second.key]) {
    const file = issueFile(session, key);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace(/^backlog_rank: .*$/m, 'backlog_rank: "hzzzzz"'),
    );
  }
  await session.restart();

  // ADR-005 §1: two clones inserting into the same gap is ordinary. Treating it
  // as corruption would let a normal merge stop the board.
  assert.deepEqual((await keys(session)).sort(), [first.key, second.key].sort());
  assert.deepEqual(await quarantined(session), []);
});

test("a duplicate display key is left for rekeying rather than quarantined", async (t) => {
  const session = await makeSession(t);
  const original = await make(session, "원본");
  await session.server.close();

  // Same key, different uid — what two clones numbering independently produce.
  const twin = path.join(session.board, "issues", "LJ", "LJ-dup.md");
  fs.writeFileSync(
    twin,
    fs
      .readFileSync(issueFile(session, original.key), "utf8")
      .replace(/^uid: .*$/m, "uid: 01JTWIN000000000000000000"),
  );
  await session.restart();

  // D3 gives this to automatic rekeying (R26). Quarantining it would take a
  // recoverable situation and stop the board over it.
  const records = await quarantined(session);
  assert.deepEqual(
    records.filter((entry) => entry.reason === "duplicate_uid"),
    [],
  );
});

test("two broken files among five thousand leave the other 4,998 working", { timeout: 180_000 }, async (t) => {
  const session = await makeSession(t);
  await session.server.close();

  const directory = path.join(session.board, "issues", "LJ");
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 1; index <= 5_000; index += 1) {
    fs.writeFileSync(
      path.join(directory, `LJ-${index + 100}.md`),
      `---\nuid: 01JBULK${String(index).padStart(19, "0")}\nkey: LJ-${index + 100}\n` +
        `type: task\ntitle: 대량 ${index}\nstatus: BACKLOG\nbacklog_rank: "${String(index).padStart(6, "0")}"\n---\n\n`,
    );
  }

  // One unparseable, one mid-merge.
  fs.writeFileSync(path.join(directory, "LJ-200.md"), "---\nuid: [unclosed\n---\n");
  fs.writeFileSync(
    path.join(directory, "LJ-300.md"),
    "---\nuid: 01JCONFLICT000000000000000\n<<<<<<< HEAD\ntitle: 내 쪽\n=======\ntitle: 남의 쪽\n>>>>>>> theirs\n---\n\n",
  );

  await session.restart();

  const records = await quarantined(session);
  assert.equal(records.length, 2, `expected two quarantined, got ${records.length}`);
  // The parser's own reason codes, not a flattened "broken": a conflict marker
  // means finish the merge, a yaml error means the file is malformed.
  assert.deepEqual(
    records.map((entry) => entry.reason).sort(),
    ["conflict_marker", "yaml_error"].sort(),
  );

  // AC10: the other 4,998 behave normally — listed, readable, and writable.
  const listed = await call(session, "GET", "/issues?limit=500");
  assert.equal(listed.status, 200);
  const shown = (listed.json as unknown as { issues: Array<{ key: string }> }).issues;
  assert.equal(shown.length, 500);
  assert.equal(shown.some((issue) => issue.key === "LJ-200"), false, "the broken one is hidden");

  const target = shown.find((issue) => issue.key !== "LJ-200")!.key;
  const current = await call(session, "GET", `/issues/${target}`);
  const moved = await call(session, "POST", `/issues/${target}/transitions`, {
    ifMatch: current.etag ?? "",
    body: { to: "TODO" },
  });
  assert.equal(moved.status, 200, "a state transition still works");
  assert.equal((await make(session, "여전히 만들 수 있다")).key.startsWith("LJ-"), true);
});
