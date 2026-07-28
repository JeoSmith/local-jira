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
  board: string;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
}

async function makeSession(t: { after: (fn: () => void) => void }): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-links-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "l@example.com"]);
  git(repo, ["config", "user.name", "Links"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo });
  cli(["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]);
  cli(["admin", "create", "--id", "owner", "--name", "오너", "--password", PASSWORD]);

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
    board: path.join(repo, ".localjira"),
  };
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
    claimable: response.headers.get("x-claimable"),
    blockedBy: response.headers.get("x-blocked-by"),
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
  };
}

interface Made {
  key: string;
  uid: string;
  etag: string;
}

async function make(session: Session, title: string): Promise<Made> {
  const created = await call(session, "POST", "/issues", {
    body: { project: "LJ", type: "task", title },
  });
  assert.equal(created.status, 201);
  return {
    key: created.json.key as unknown as string,
    uid: created.json.uid as unknown as string,
    etag: created.etag ?? "",
  };
}

async function etagOf(session: Session, key: string): Promise<string> {
  return (await call(session, "GET", `/issues/${key}`)).etag ?? "";
}

async function link(
  session: Session,
  from: string,
  kind: string,
  to: string,
): Promise<ReturnType<typeof call> extends Promise<infer T> ? T : never> {
  return call(session, "POST", `/issues/${from}/links`, {
    ifMatch: await etagOf(session, from),
    body: { kind, to },
  });
}

test("a link is recorded on the file that declares it, as a uid reference", async (t) => {
  const session = await makeSession(t);
  const blocker = await make(session, "선행 작업");
  const blocked = await make(session, "후행 작업");

  const added = await link(session, blocked.key, "blocked_by", blocker.uid);
  assert.equal(added.status, 201);

  const file = fs.readFileSync(
    path.join(session.board, "issues", "LJ", `${blocked.key}.md`),
    "utf8",
  );
  assert.match(file, new RegExp(`- \\{kind: blocked_by, to: ${blocker.uid}\\}`));

  // S1-D4: only the declaring side's file is touched.
  const other = fs.readFileSync(
    path.join(session.board, "issues", "LJ", `${blocker.key}.md`),
    "utf8",
  );
  assert.doesNotMatch(other, /links:/, "the other issue's file must not be rewritten");
});

test("the relation still shows up on the issue that did not declare it", async (t) => {
  const session = await makeSession(t);
  const blocker = await make(session, "선행");
  const blocked = await make(session, "후행");
  await link(session, blocked.key, "blocked_by", blocker.uid);

  const reverse = await call(session, "GET", `/issues/${blocker.key}/links`);
  const links = (reverse.json as unknown as {
    links: Array<{ kind: string; key: string; declared: boolean }>;
  }).links;

  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "blocks", "read from this end it is the inverse");
  assert.equal(links[0].key, blocked.key);
  assert.equal(links[0].declared, false, "so the caller knows it cannot delete it here");
});

test("both sides declaring the same relation is reported once", async (t) => {
  const session = await makeSession(t);
  const first = await make(session, "A");
  const second = await make(session, "B");

  await link(session, first.key, "blocks", second.uid);
  await link(session, second.key, "blocked_by", first.uid);

  const listed = await call(session, "GET", `/issues/${first.key}/links`);
  const links = (listed.json as unknown as { links: Array<{ kind: string }> }).links;
  assert.equal(links.length, 1, "one relation, however many files mention it (S1-D4)");
  assert.equal(links[0].kind, "blocks");
});

test("re-adding the same link is a no-op rather than a duplicate", async (t) => {
  const session = await makeSession(t);
  const blocker = await make(session, "선행");
  const blocked = await make(session, "후행");

  const first = await link(session, blocked.key, "blocked_by", blocker.uid);
  const again = await link(session, blocked.key, "blocked_by", blocker.uid);

  assert.equal(again.status, 200, "idempotent, not created again");
  assert.equal(again.etag, first.etag, "and the file did not move");

  const listed = await call(session, "GET", `/issues/${blocked.key}/links`);
  assert.equal((listed.json as unknown as { links: unknown[] }).links.length, 1);
});

test("bad link requests are refused with the reason", async (t) => {
  const session = await makeSession(t);
  const issue = await make(session, "대상");
  const other = await make(session, "상대");

  const badKind = await link(session, issue.key, "supersedes", other.uid);
  assert.equal(badKind.status, 400);
  assert.equal(
    (badKind.json as unknown as { error: { code: string; detail: string } }).error.code,
    "E_INVALID_LINK_KIND",
  );
  assert.match(
    (badKind.json as unknown as { error: { detail: string } }).error.detail,
    /blocks, blocked_by, relates_to, duplicates/,
  );

  const missing = await link(session, issue.key, "relates_to", "01JNOSUCHISSUE0000000000000");
  assert.equal(missing.status, 400);
  assert.equal(
    (missing.json as unknown as { error: { code: string } }).error.code,
    "E_LINK_TARGET_NOT_FOUND",
  );

  const itself = await link(session, issue.key, "relates_to", issue.uid);
  assert.equal(itself.status, 400);
  assert.equal(
    (itself.json as unknown as { error: { code: string } }).error.code,
    "E_LINK_SELF",
  );
});

test("an unfinished blocker makes an issue unclaimable, and says which", async (t) => {
  const session = await makeSession(t);
  const blocker = await make(session, "먼저 끝나야 할 것");
  const blocked = await make(session, "기다리는 것");
  await link(session, blocked.key, "blocked_by", blocker.uid);

  const shown = await call(session, "GET", `/issues/${blocked.key}`);
  assert.equal(shown.claimable, "false");
  assert.equal(shown.blockedBy, blocker.key, "the reason travels with the answer");

  const links = await call(session, "GET", `/issues/${blocked.key}/links`);
  assert.deepEqual(
    (links.json as unknown as { blockedBy: string[] }).blockedBy,
    [blocker.key],
  );
});

test("finishing the blocker clears the way", async (t) => {
  const session = await makeSession(t);
  const blocker = await make(session, "선행");
  const blocked = await make(session, "후행");
  await link(session, blocked.key, "blocked_by", blocker.uid);

  for (const to of ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]) {
    const moved = await call(session, "POST", `/issues/${blocker.key}/transitions`, {
      ifMatch: await etagOf(session, blocker.key),
      body: { to },
    });
    assert.equal(moved.status, 200, `could not move to ${to}`);
  }

  const shown = await call(session, "GET", `/issues/${blocked.key}`);
  assert.equal(shown.claimable, "true");
  assert.equal(shown.blockedBy, null);
});

test("a cancelled blocker counts as settled", async (t) => {
  const session = await makeSession(t);
  const blocker = await make(session, "취소될 선행");
  const blocked = await make(session, "후행");
  await link(session, blocked.key, "blocked_by", blocker.uid);

  const cancelled = await call(session, "POST", `/issues/${blocker.key}/transitions`, {
    ifMatch: await etagOf(session, blocker.key),
    body: { to: "CANCELLED" },
  });
  assert.equal(cancelled.status, 200);

  // S1-D5: work that will never happen is not work that is still in the way.
  const shown = await call(session, "GET", `/issues/${blocked.key}`);
  assert.equal(shown.claimable, "true");
});

test("removing a link recomputes claimability immediately", async (t) => {
  const session = await makeSession(t);
  const blocker = await make(session, "선행");
  const blocked = await make(session, "후행");
  await link(session, blocked.key, "blocked_by", blocker.uid);

  assert.equal((await call(session, "GET", `/issues/${blocked.key}`)).claimable, "false");

  const id = `blocked_by:${blocker.uid}`;
  const removed = await call(session, "DELETE", `/issues/${blocked.key}/links/${id}`, {
    ifMatch: await etagOf(session, blocked.key),
  });
  assert.equal(removed.status, 200);

  const shown = await call(session, "GET", `/issues/${blocked.key}`);
  assert.equal(shown.claimable, "true");
  const remaining = await call(session, "GET", `/issues/${blocked.key}/links`);
  assert.deepEqual((remaining.json as unknown as { links: unknown[] }).links, []);

  // And the key is gone from the file, not merely filtered out of the view.
  const file = fs.readFileSync(
    path.join(session.board, "issues", "LJ", `${blocked.key}.md`),
    "utf8",
  );
  assert.doesNotMatch(file, new RegExp(blocker.uid));
});

test("a relation can only be removed from the side that declared it", async (t) => {
  const session = await makeSession(t);
  const blocker = await make(session, "선행");
  const blocked = await make(session, "후행");
  await link(session, blocked.key, "blocked_by", blocker.uid);

  // Seen from the blocker the relation reads `blocks`, but its file says nothing.
  const refused = await call(
    session,
    "DELETE",
    `/issues/${blocker.key}/links/blocks:${blocked.uid}`,
    { ifMatch: await etagOf(session, blocker.key) },
  );
  assert.equal(refused.status, 404);
  assert.equal(
    (refused.json as unknown as { error: { code: string } }).error.code,
    "E_LINK_NOT_FOUND",
  );

  const intact = await call(session, "GET", `/issues/${blocked.key}/links`);
  assert.equal((intact.json as unknown as { links: unknown[] }).links.length, 1);
});

test("linking requires If-Match like any other write", async (t) => {
  const session = await makeSession(t);
  const blocker = await make(session, "선행");
  const blocked = await make(session, "후행");

  const missing = await call(session, "POST", `/issues/${blocked.key}/links`, {
    body: { kind: "blocked_by", to: blocker.uid },
  });
  assert.equal(missing.status, 428);

  const stale = await call(session, "POST", `/issues/${blocked.key}/links`, {
    ifMatch: '"0000000000000000000000000000000000000000000000000000000000000000"',
    body: { kind: "blocked_by", to: blocker.uid },
  });
  assert.equal(stale.status, 412);
});
