import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CredentialStore, TOKEN_PREFIX } from "../../src/auth/credentials.ts";
import { startServer, type RunningServer } from "../../src/server/http.ts";

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-pat-")));
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

  return {
    repo,
    board: path.join(repo, ".localjira"),
    local: path.join(repo, ".localjira", ".local"),
  };
}

interface Call {
  status: number;
  json: Record<string, never>;
}

async function call(
  server: RunningServer,
  method: string,
  route: string,
  options: { body?: unknown; cookie?: string; bearer?: string; etag?: string } = {},
): Promise<Call> {
  const response = await fetch(`${server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
      ...(options.etag ? { "if-match": options.etag } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
  };
}

async function signIn(server: RunningServer, id: string): Promise<string> {
  const response = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, password: PASSWORD }),
  });
  assert.equal(response.status, 200, `${id} could not sign in`);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

interface Session {
  server: RunningServer;
  sandbox: Sandbox;
  admin: string;
  member: string;
}

async function session(t: {
  after: (fn: () => void | Promise<void>) => void;
}): Promise<Session> {
  const sandbox = makeSandbox(t);
  cli(sandbox.repo, ["admin", "create", "--id", "root", "--name", "루트", "--password", PASSWORD]);
  cli(sandbox.repo, [
    "admin", "create", "--id", "dev", "--name", "개발자", "--password", PASSWORD,
    "--role", "member",
  ]);

  const server = await startServer({ cwd: sandbox.repo, port: 0, watch: false });
  t.after(() => server.close());

  return {
    server,
    sandbox,
    admin: await signIn(server, "root"),
    member: await signIn(server, "dev"),
  };
}

function eventLines(sandbox: Sandbox): string[] {
  const root = path.join(sandbox.board, "events");
  if (!fs.existsSync(root)) {
    return [];
  }
  const lines: string[] = [];
  for (const day of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, day))) {
      lines.push(
        ...fs
          .readFileSync(path.join(root, day, file), "utf8")
          .split("\n")
          .filter((line) => line.trim() !== ""),
      );
    }
  }
  return lines;
}

// ── the secret ──────────────────────────────────────────────────────────────

test("the plaintext is returned once and then does not exist anywhere", async (t) => {
  const s = await session(t);

  const issued = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { name: "에이전트", user: "dev" },
  });
  assert.equal(issued.status, 201);
  const secret = issued.json.token as unknown as string;
  assert.ok(secret.startsWith(TOKEN_PREFIX), `recognisable as a credential: ${secret}`);

  // Every later reading of the same token, by every route that has one.
  const listed = await call(s.server, "GET", "/tokens", { cookie: s.admin });
  assert.equal(listed.status, 200);
  const body = JSON.stringify(listed.json);
  assert.equal(body.includes(secret), false, "the list must not hand it back");

  // And not in the database either: a copy of the file must not be replayable.
  const bytes = fs.readFileSync(path.join(s.sandbox.local, "credentials.sqlite"));
  assert.equal(bytes.includes(secret), false, "only the hash is stored");
});

test("no token value or hash reaches the tracked tree", async (t) => {
  const s = await session(t);
  const issued = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "dev" },
  });
  const secret = issued.json.token as unknown as string;
  const tokenId = issued.json.token_id as unknown as string;

  // N6: `.localjira/` is a git worktree that gets pushed. A secret there is a
  // secret shared with everyone holding the repository.
  const walk = (directory: string): string[] => {
    const found: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".local" || entry.name === ".git") {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        found.push(...walk(absolute));
      } else {
        found.push(fs.readFileSync(absolute, "utf8"));
      }
    }
    return found;
  };

  const contents = walk(s.sandbox.board).join("\n");
  assert.equal(contents.includes(secret), false, "the plaintext is not in the board tree");
  assert.equal(/[0-9a-f]{64}/.test(contents.replace(tokenId, "")), false, "nor any token hash");
  // But the audit does name the token, or a revocation could not be traced.
  assert.ok(contents.includes(tokenId), "token_id survives redaction on purpose");
});

// ── refusals ────────────────────────────────────────────────────────────────

test("a revoked token is refused on the very next request", async (t) => {
  const s = await session(t);
  const issued = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "dev" },
  });
  const secret = issued.json.token as unknown as string;
  const tokenId = issued.json.token_id as unknown as string;

  assert.equal((await call(s.server, "GET", "/issues", { bearer: secret })).status, 200);

  const revoked = await call(s.server, "DELETE", `/tokens/${tokenId}`, { cookie: s.admin });
  assert.equal(revoked.status, 200);

  // AC6: immediately, with no restart and nothing to invalidate — the check
  // reads the row on every request, so there is no cache to be stale.
  const after = await call(s.server, "GET", "/issues", { bearer: secret });
  assert.equal(after.status, 401);
});

test("an expired token is refused without restarting the server", async (t) => {
  const s = await session(t);
  const store = new CredentialStore(s.sandbox.local);
  t.after(() => store.close());

  const expired = store.createToken({
    userId: "dev",
    name: "어제 것",
    scopes: ["issue:read"],
    projectScope: null,
    expiresAt: Date.now() - 1_000,
  });

  const response = await call(s.server, "GET", "/issues", { bearer: expired.token });
  assert.equal(response.status, 401);
});

test("an unknown or tampered token is refused", async (t) => {
  const s = await session(t);
  const issued = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "dev" },
  });
  const secret = issued.json.token as unknown as string;

  for (const bearer of [
    `${TOKEN_PREFIX}nothinglikethis`,
    `${secret}x`,
    secret.slice(0, -1),
    "not-even-shaped-right",
  ]) {
    const response = await call(s.server, "GET", "/issues", { bearer });
    assert.equal(response.status, 401, `${bearer} should not authenticate`);
  }
});

test("a token does what its scopes name, and nothing beside them", async (t) => {
  const s = await session(t);
  const issued = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "dev", scopes: ["issue:read", "issue:edit"] },
  });
  const secret = issued.json.token as unknown as string;

  const created = await call(s.server, "POST", "/issues", {
    bearer: secret,
    body: { project: "LJ", type: "task", title: "토큰이 만든 이슈" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  // `issue:edit` is not `issue:rank`, and D9 keeps the two apart on purpose:
  // an agent may fix an issue without deciding what the team does next.
  const ranked = await call(
    s.server,
    "POST",
    `/issues/${created.json.key as unknown as string}/rank`,
    { bearer: secret, body: { field: "backlog_rank", after: null, before: null } },
  );
  assert.equal(ranked.status, 403);
  assert.equal(ranked.json.error?.code, "E_TOKEN_SCOPE");
});

test("a member may issue their own token but not somebody else's", async (t) => {
  const s = await session(t);

  const own = await call(s.server, "POST", "/tokens", {
    cookie: s.member,
    body: { name: "내 토큰" },
  });
  assert.equal(own.status, 201, JSON.stringify(own.json));
  assert.equal(own.json.user, "dev");

  // S3-D8: issuing under another name would let a member produce audit records
  // that read as somebody else's actions.
  const other = await call(s.server, "POST", "/tokens", {
    cookie: s.member,
    body: { user: "root" },
  });
  assert.equal(other.status, 403);

  const denied = eventLines(s.sandbox).filter((line) => line.includes("access.denied"));
  assert.equal(denied.length, 1, "and the attempt is on the record");
});

test("a member may not revoke another account's token", async (t) => {
  const s = await session(t);
  const issued = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "root" },
  });

  const attempt = await call(
    s.server,
    "DELETE",
    `/tokens/${issued.json.token_id as unknown as string}`,
    { cookie: s.member },
  );
  assert.equal(attempt.status, 403);

  // Still usable, or the refusal would have been cosmetic.
  const secret = issued.json.token as unknown as string;
  assert.equal((await call(s.server, "GET", "/issues", { bearer: secret })).status, 200);
});

test("scopes outside the fixed seven are refused", async (t) => {
  const s = await session(t);
  const response = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "dev", scopes: ["issue:read", "board:destroy"] },
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.error?.code, "E_INVALID_SCOPE");
});

// ── expiry policy (S3-D7) ───────────────────────────────────────────────────

test("the default is 90 days, and unlimited must be asked for explicitly", async (t) => {
  const s = await session(t);
  const day = 24 * 60 * 60 * 1000;

  const byDefault = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "dev" },
  });
  const at = Date.parse(byDefault.json.expires_at as unknown as string);
  assert.ok(
    Math.abs(at - (Date.now() + 90 * day)) < 60_000,
    `expected ~90 days, got ${byDefault.json.expires_at}`,
  );

  // Saying nothing and saying "never" are different requests. Collapsing them
  // would turn every forgotten field into an unlimited credential.
  const forever = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "dev", expires_in_days: null },
  });
  assert.equal(forever.json.expires_at, null);

  const chosen = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "dev", expires_in_days: 7 },
  });
  assert.ok(
    Math.abs(Date.parse(chosen.json.expires_at as unknown as string) - (Date.now() + 7 * day)) <
      60_000,
  );

  for (const bad of [0, -1, 1.5, "many"]) {
    const response = await call(s.server, "POST", "/tokens", {
      cookie: s.admin,
      body: { user: "dev", expires_in_days: bad },
    });
    assert.equal(response.status, 400, `${bad} is not a number of days`);
  }
});

test("an unlimited token keeps working, and last_used_at is what makes it findable", async (t) => {
  const s = await session(t);
  const issued = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "dev", expires_in_days: null },
  });
  const secret = issued.json.token as unknown as string;
  assert.equal(issued.json.last_used_at, null, "not used yet");

  assert.equal((await call(s.server, "GET", "/issues", { bearer: secret })).status, 200);

  // S3-D7 accepts tokens that never expire, so the only signal that one has
  // fallen out of use is this column. It is not optional decoration.
  const listed = await call(s.server, "GET", "/tokens", { cookie: s.admin });
  const record = (listed.json.tokens as unknown as Array<Record<string, unknown>>).find(
    (entry) => entry.token_id === issued.json.token_id,
  )!;
  assert.notEqual(record.last_used_at, null, "using a token records that it was used");
  assert.equal(record.expires_at, null);
});

test("reading with a token records no event, only the timestamp", async (t) => {
  const s = await session(t);
  const issued = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "dev" },
  });
  const before = eventLines(s.sandbox).length;

  for (let index = 0; index < 3; index += 1) {
    await call(s.server, "GET", "/issues", { bearer: issued.json.token as unknown as string });
  }

  // N7 excludes reads and searches. A file per read would also make an agent
  // that only polls the noisiest writer on the board.
  assert.equal(eventLines(s.sandbox).length, before, "reads are not audited");
});

// ── audit ───────────────────────────────────────────────────────────────────

test("issue and revoke are both recorded, by token_id and nothing else", async (t) => {
  const s = await session(t);
  const issued = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "dev", name: "감사용" },
  });
  const secret = issued.json.token as unknown as string;
  const tokenId = issued.json.token_id as unknown as string;
  await call(s.server, "DELETE", `/tokens/${tokenId}`, { cookie: s.admin });

  const lines = eventLines(s.sandbox);
  const verbs = lines
    .map((line) => JSON.parse(line) as { verb: string })
    .map((event) => event.verb);
  assert.ok(verbs.includes("token.issued"), verbs.join(", "));
  assert.ok(verbs.includes("token.revoked"), verbs.join(", "));

  const joined = lines.join("\n");
  assert.equal(joined.includes(secret), false, "the plaintext is never in an event");
  assert.ok(joined.includes(tokenId), "but the token is identifiable");
});

// ── the store on its own ────────────────────────────────────────────────────

test("a token whose user is gone authenticates as nobody", async (t) => {
  const s = await session(t);
  const issued = await call(s.server, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "dev" },
  });
  const secret = issued.json.token as unknown as string;
  assert.equal((await call(s.server, "GET", "/issues", { bearer: secret })).status, 200);

  const users = path.join(s.sandbox.board, "users.yaml");
  const text = fs.readFileSync(users, "utf8");
  fs.writeFileSync(users, text.slice(0, text.indexOf("  - id: dev")));

  // Removing somebody from the file is how access is revoked, and it has to
  // reach tokens too — otherwise the account is gone but its keys still work.
  const rebuilt = await call(s.server, "POST", "/index/rebuild", { cookie: s.admin });
  assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.json));
  const after = await call(s.server, "GET", "/issues", { bearer: secret });
  assert.equal(after.status, 401);
});

test("a corrupt scopes column grants nothing rather than everything", async (t) => {
  const s = await session(t);
  const store = new CredentialStore(s.sandbox.local);
  t.after(() => store.close());

  const issued = store.createToken({
    userId: "dev",
    name: null,
    scopes: ["issue:read"],
    projectScope: null,
    expiresAt: null,
  });

  const db = new (await import("node:sqlite")).DatabaseSync(store.path);
  db.prepare("UPDATE tokens SET scopes = ? WHERE token_id = ?").run("{not json", issued.record.tokenId);
  db.close();

  const reread = new CredentialStore(s.sandbox.local);
  t.after(() => reread.close());
  const found = reread.resolveToken(issued.token);
  assert.equal(found.ok, true);
  assert.deepEqual(found.ok && found.record.scopes, [], "unreadable scopes are no scopes");
});
