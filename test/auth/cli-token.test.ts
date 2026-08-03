/**
 * The CLI writes as whoever the token says, or it does not write.
 *
 * The defect this closes: `localjira issue create` recorded every caller as
 * `{ id: "local", kind: "human" }`. An agent reaches for the CLI first — it is
 * shorter and needs no header — so its issues were filed as a person's work and
 * the `agent` badge §8 promises was quietly false on that path. D16 leans on
 * that badge as one of three gates, so the gate has to be real.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CredentialStore } from "../../src/auth/credentials.ts";
import { TOKEN_ENV } from "../../src/auth/cli-actor.ts";
import { startServer } from "../../src/server/http.ts";

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

function cli(cwd: string, args: string[], token?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: token === undefined
      ? { ...process.env, [TOKEN_ENV]: "" }
      : { ...process.env, [TOKEN_ENV]: token },
  });
}

function makeSandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-clitok-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  const init = cli(repo, [
    "init", "--project-key", "LJ", "--project-name", "Local Jira", "--timezone", "Asia/Seoul",
  ]);
  assert.equal(init.status, 0, init.stderr);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(
    cli(repo, ["admin", "create", "--id", "kim", "--name", "김", "--password", PASSWORD]).status,
    0,
  );
  assert.equal(
    cli(repo, [
      "admin", "create", "--id", "bot", "--name", "봇", "--password", PASSWORD, "--role", "agent",
    ]).status,
    0,
  );

  return {
    repo,
    board: path.join(repo, ".localjira"),
    local: path.join(repo, ".localjira", ".local"),
  };
}

/** Issues a token through the CLI, which is the only path that does not need a server. */
function issueToken(s: Sandbox, user: string, scopes: string[]): string {
  const args = ["token", "create", "--user", user, "--password", PASSWORD];
  for (const scope of scopes) {
    args.push("--scope", scope);
  }
  const made = cli(s.repo, args);
  assert.equal(made.status, 0, made.stderr);
  return made.stdout.trim();
}

function issueFiles(s: Sandbox): string[] {
  const directory = path.join(s.board, "issues", "LJ");
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

test("an agent's token makes the CLI record an agent", async (t) => {
  const s = makeSandbox(t);
  const token = issueToken(s, "bot", ["issue:read", "issue:edit"]);

  const made = cli(s.repo, ["issue", "create", "--project", "LJ", "--type", "story",
    "--title", "에이전트가 만든 것"], token);
  assert.equal(made.status, 0, made.stderr);

  const file = fs.readFileSync(path.join(s.board, "issues", "LJ", "LJ-1.md"), "utf8");
  assert.match(file, /^created_by_kind: agent$/m);
  assert.match(file, /^last_actor_kind: agent$/m);

  const events = fs
    .readdirSync(path.join(s.board, "events"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .flatMap((entry) =>
      fs
        .readFileSync(path.join(entry.parentPath, entry.name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
  const created = events.find((event) => event.verb === "issue.created");
  assert.equal(created?.actor_id, "bot");
  assert.equal(created?.actor_kind, "agent");
});

/**
 * The two write paths must not disagree.
 *
 * If the CLI and the API record the same token differently, the badge depends on
 * which one the agent happened to use — which is the bug, restated.
 */
test("the CLI and the API record the same token the same way", async (t) => {
  const s = makeSandbox(t);
  const token = issueToken(s, "bot", ["issue:read", "issue:edit"]);

  assert.equal(
    cli(s.repo, ["issue", "create", "--project", "LJ", "--type", "story", "--title", "CLI"], token)
      .status,
    0,
  );

  const server = await startServer({ cwd: s.repo, port: 0, watch: false });
  t.after(() => server.close());
  const response = await fetch(new URL("/issues", server.url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ project: "LJ", type: "story", title: "API" }),
  });
  assert.equal(response.status, 201);

  const [viaCli, viaApi] = ["LJ-1.md", "LJ-2.md"].map((name) =>
    fs.readFileSync(path.join(s.board, "issues", "LJ", name), "utf8"),
  );
  const kindOf = (text: string) => /^created_by_kind: (\S+)$/m.exec(text)?.[1];
  assert.equal(kindOf(viaCli), "agent");
  assert.equal(kindOf(viaApi), kindOf(viaCli), "the path must not change the record");
});

test("a member's token records a human, so the kind follows the role and not the path", async (t) => {
  const s = makeSandbox(t);
  const token = issueToken(s, "kim", ["issue:read", "issue:edit"]);

  assert.equal(
    cli(s.repo, ["issue", "create", "--project", "LJ", "--type", "story", "--title", "사람"], token)
      .status,
    0,
  );
  const file = fs.readFileSync(path.join(s.board, "issues", "LJ", "LJ-1.md"), "utf8");
  assert.match(file, /^created_by_kind: human$/m);
});

test("writing with no token is refused, and nothing is written", async (t) => {
  const s = makeSandbox(t);

  const refused = cli(s.repo, ["issue", "create", "--project", "LJ", "--type", "story",
    "--title", "주체 없음"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /E_TOKEN_REQUIRED/);
  // The refusal has to name the way out, or requiring a token is just a wall.
  assert.match(refused.stderr, /localjira token create/);
  assert.deepEqual(issueFiles(s), [], "a refused write must leave no file behind");
});

test("reading needs no token", async (t) => {
  const s = makeSandbox(t);
  // Otherwise `doctor` could not diagnose a board whose credentials are the
  // thing that is broken.
  assert.equal(cli(s.repo, ["issue", "list"]).status, 0);
  assert.equal(cli(s.repo, ["doctor"]).status, 0);
  assert.equal(cli(s.repo, ["index", "status"]).status, 0);
});

test("the four refusals are told apart", async (t) => {
  const s = makeSandbox(t);
  const create = ["issue", "create", "--project", "LJ", "--type", "story", "--title", "x"];

  const unknown = cli(s.repo, create, "ljp_not_a_real_token");
  assert.match(unknown.stderr, /E_TOKEN_INVALID/);

  const narrow = issueToken(s, "bot", ["issue:read"]);
  const forbidden = cli(s.repo, create, narrow);
  assert.match(forbidden.stderr, /E_FORBIDDEN/);
  assert.match(forbidden.stderr, /issue:edit/, "it must say which scope is missing");

  const store = new CredentialStore(s.local);
  const revoked = store.listTokens("bot").find((entry) => entry.scopes.length === 1);
  store.revokeToken(revoked!.tokenId);
  store.close();
  assert.match(cli(s.repo, create, narrow).stderr, /E_TOKEN_REVOKED/);

  const expiring = issueToken(s, "bot", ["issue:edit"]);
  const second = new CredentialStore(s.local);
  const fresh = second.listTokens("bot").find(
    (entry) => entry.revokedAt === null && entry.scopes.join() === "issue:edit",
  );
  second.close();
  // Reach past the API to age it: waiting out a real expiry is not a test.
  assert.equal(ageToken(s, fresh!.tokenId), true);
  assert.match(cli(s.repo, create, expiring).stderr, /E_TOKEN_EXPIRED/);

  assert.deepEqual(issueFiles(s), [], "no refusal may write a file");
});

/** Ages a token by writing directly to the store, which the API has no verb for. */
function ageToken(s: Sandbox, tokenId: string): boolean {
  const db = new DatabaseSync(path.join(s.local, "credentials.sqlite"));
  const changed = db.prepare("UPDATE tokens SET expires_at = 1 WHERE token_id = ?").run(tokenId);
  db.close();
  return Number(changed.changes) > 0;
}

test("a token whose account left users.yaml stops working", async (t) => {
  const s = makeSandbox(t);
  const token = issueToken(s, "bot", ["issue:edit"]);

  const users = path.join(s.board, "users.yaml");
  fs.writeFileSync(
    users,
    fs.readFileSync(users, "utf8").replace(/ {2}- id: bot\n(?: {4}.*\n)*/, ""),
  );
  // The index has to see the file change before the check can, which is what
  // `reconcile` does — the same path a pull takes.
  assert.equal(cli(s.repo, ["index", "reconcile"]).status, 0);

  const refused = cli(s.repo, ["issue", "create", "--project", "LJ", "--type", "story",
    "--title", "x"], token);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /E_TOKEN_ORPHANED/);
});

test("using a token marks it used", async (t) => {
  const s = makeSandbox(t);
  const token = issueToken(s, "bot", ["issue:edit"]);

  const before = new CredentialStore(s.local);
  const idle = before.listTokens("bot")[0];
  before.close();
  assert.equal(idle.lastUsedAt, null, "issuing is not using");

  assert.equal(
    cli(s.repo, ["issue", "create", "--project", "LJ", "--type", "story", "--title", "x"], token)
      .status,
    0,
  );

  const after = new CredentialStore(s.local);
  const used = after.listTokens("bot")[0];
  after.close();
  assert.notEqual(used.lastUsedAt, null, "a CLI call is a use of the token");
});

/**
 * N6 keeps the secret out of files and logs, and an error stream is a log.
 */
test("the token never appears in the board, the output or a refusal", async (t) => {
  const s = makeSandbox(t);
  const token = issueToken(s, "bot", ["issue:edit"]);

  const made = cli(s.repo, ["issue", "create", "--project", "LJ", "--type", "story",
    "--title", "x", "--json"], token);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(made.stdout.includes(token), false, "not in the success output");

  const refused = cli(s.repo, ["issue", "create", "--project", "LJ", "--type", "story",
    "--title", "x"], `${token}-wrong`);
  assert.equal(refused.stderr.includes(token), false, "not in a refusal");

  const walk = (from: string): string[] =>
    fs.readdirSync(from, { withFileTypes: true }).flatMap((entry) => {
      const absolute = path.join(from, entry.name);
      if (entry.name === ".local") return [];
      return entry.isDirectory() ? walk(absolute) : [fs.readFileSync(absolute, "utf8")];
    });
  for (const contents of walk(s.board)) {
    assert.equal(contents.includes(token), false, "not anywhere in the board tree");
  }
});

test("token create refuses a wrong password without saying which half was wrong", async (t) => {
  const s = makeSandbox(t);

  const wrong = cli(s.repo, ["token", "create", "--user", "bot", "--password", "not the password"]);
  assert.equal(wrong.status, 1);
  const absent = cli(s.repo, ["token", "create", "--user", "nobody", "--password", PASSWORD]);
  assert.equal(absent.status, 1);
  // The same message for both: telling them apart makes this an account
  // enumerator.
  assert.equal(
    wrong.stderr.replace(/nobody/g, "bot"),
    absent.stderr.replace(/nobody/g, "bot"),
  );
});

test("token create defaults to the agent scopes and can be told otherwise", async (t) => {
  const s = makeSandbox(t);

  const made = cli(s.repo, ["token", "create", "--user", "bot", "--password", PASSWORD, "--json"]);
  assert.equal(made.status, 0, made.stderr);
  const scopes = (JSON.parse(made.stdout) as { record: { scopes: string[] } }).record.scopes;
  // D9: the default set is deliberately without rank and delete.
  assert.equal(scopes.includes("issue:rank"), false);
  assert.equal(scopes.includes("issue:delete"), false);
  // And without issue:edit, so loading a backlog is a permission somebody grants
  // on purpose rather than one every agent token carries.
  assert.equal(scopes.includes("issue:edit"), false);

  const rejected = cli(s.repo, [
    "token", "create", "--user", "bot", "--password", PASSWORD, "--scope", "issue:everything",
  ]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /issue:everything/);
});
