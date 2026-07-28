import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CredentialStore } from "../../src/auth/credentials.ts";
import {
  ARGON2_ALGORITHM,
  hashPassword,
  PasswordError,
  verifyPassword,
} from "../../src/auth/password.ts";
import {
  authenticate,
  bootstrapAdmin,
  createUser,
  listUsers,
  needsBootstrap,
  UserError,
} from "../../src/domain/users.ts";
import { startServer, type RunningServer } from "../../src/server/http.ts";
import { openBoard, type BoardHandle } from "../../src/storage/board.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

interface Sandbox {
  repo: string;
  board: string;
  open(): BoardHandle;
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

function makeSandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-auth-")));
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
  return { repo, board: path.join(repo, ".localjira"), open: () => openBoard(repo) };
}

async function withServer(
  sandbox: Sandbox,
  body: (server: RunningServer) => Promise<void>,
): Promise<void> {
  const server = await startServer({ cwd: sandbox.repo, port: 0 });
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

async function request(
  server: RunningServer,
  method: string,
  route: string,
  options: { body?: unknown; cookie?: string } = {},
): Promise<{ status: number; json: Record<string, never>; cookie: string | null; etag: string | null }> {
  const response = await fetch(`${server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
    cookie: response.headers.get("set-cookie"),
    etag: response.headers.get("etag"),
  };
}

// ── password hashing ────────────────────────────────────────────────────────

test("hashes passwords with argon2id and self-describing parameters", () => {
  const encoded = hashPassword(PASSWORD);
  const [algorithm, params] = encoded.split("$");

  assert.equal(algorithm, ARGON2_ALGORITHM);
  assert.match(params, /^v=\d+,\d+,\d+$/);
  assert.equal(encoded.includes(PASSWORD), false, "the plaintext must not survive");

  assert.equal(verifyPassword(PASSWORD, encoded), true);
  assert.equal(verifyPassword("wrong", encoded), false);
  // Parameters travel with the hash, so raising them later does not invalidate
  // passwords already stored.
  assert.equal(verifyPassword(PASSWORD, hashPassword(PASSWORD)), true);
  assert.notEqual(hashPassword(PASSWORD), hashPassword(PASSWORD), "a fresh nonce each time");
});

test("refuses a password too short to be worth hashing", () => {
  assert.throws(() => hashPassword("short"), PasswordError);
});

test("treats a malformed stored hash as a failed verification", () => {
  for (const broken of ["", "nonsense", "argon2id$bad$x$y", "scrypt$v=1,2,3$a$b"]) {
    assert.equal(verifyPassword(PASSWORD, broken), false);
  }
});

// ── bootstrap and storage split ─────────────────────────────────────────────

test("a fresh board reports that it needs bootstrapping", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  assert.equal(needsBootstrap(board), true);
  assert.deepEqual(listUsers(board), []);
});

test("keeps identity in the tracked file and secrets out of it", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  bootstrapAdmin(board, { id: "admin", displayName: "관리자", password: PASSWORD });

  const usersYaml = fs.readFileSync(path.join(sandbox.board, "users.yaml"), "utf8");
  assert.match(usersYaml, /id: admin/);
  assert.match(usersYaml, /role: admin/);
  // N6: not one credential field may appear in the shared file.
  assert.equal(/hash|password|salt|token|secret/i.test(usersYaml), false, usersYaml);

  const status = git(sandbox.board, ["status", "--porcelain", "-uall"]);
  assert.match(status, /users\.yaml/);
  assert.equal(
    status.includes("credentials"),
    false,
    "credentials.sqlite lives under .local/ and must stay untracked",
  );
  assert.equal(
    fs.existsSync(path.join(sandbox.board, ".local", "credentials.sqlite")),
    true,
  );
});

test("stores an argon2id hash and never the plaintext", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  bootstrapAdmin(board, { id: "admin", displayName: "관리자", password: PASSWORD });

  const store = new CredentialStore(board.localDirectory);
  t.after(() => store.close());
  const hash = store.passwordHash("admin");

  assert.ok(hash);
  assert.match(hash, new RegExp(`^${ARGON2_ALGORITHM}\\$`));
  assert.equal(verifyPassword(PASSWORD, hash), true);

  const bytes = fs.readFileSync(path.join(board.localDirectory, "credentials.sqlite"));
  assert.equal(bytes.includes(PASSWORD), false, "the database must not contain the plaintext");
});

test("bootstraps only once", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  bootstrapAdmin(board, { id: "admin", displayName: "관리자", password: PASSWORD });

  assert.throws(
    () => bootstrapAdmin(board, { id: "second", displayName: "둘", password: PASSWORD }),
    (error: unknown) => {
      assert.ok(error instanceof UserError);
      assert.equal(error.code, "E_ALREADY_BOOTSTRAPPED");
      return true;
    },
  );
});

test("adds further accounts with the same split", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  bootstrapAdmin(board, { id: "admin", displayName: "관리자", password: PASSWORD });
  createUser(board, { id: "dev", displayName: "개발자", role: "member", password: PASSWORD });

  assert.deepEqual(
    listUsers(board).map((user) => `${user.id}:${user.role}`),
    ["admin:admin", "dev:member"],
  );

  const store = new CredentialStore(board.localDirectory);
  t.after(() => store.close());
  assert.ok(store.passwordHash("dev"));
  assert.equal(
    /hash|password/i.test(fs.readFileSync(path.join(sandbox.board, "users.yaml"), "utf8")),
    false,
  );
});

test("rejects malformed accounts before writing anything", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());

  bootstrapAdmin(board, { id: "admin", displayName: "관리자", password: PASSWORD });
  const before = fs.readFileSync(path.join(sandbox.board, "users.yaml"), "utf8");

  const codes: string[] = [];
  for (const input of [
    { id: "Bad Id", displayName: "x", role: "member" as const, password: PASSWORD },
    { id: "ok", displayName: "  ", role: "member" as const, password: PASSWORD },
    { id: "ok", displayName: "x", role: "wizard" as never, password: PASSWORD },
    { id: "admin", displayName: "x", role: "member" as const, password: PASSWORD },
    { id: "ok", displayName: "x", role: "member" as const, password: "tiny" },
  ]) {
    try {
      createUser(board, input);
      codes.push("(accepted)");
    } catch (error) {
      codes.push(error instanceof Error ? (error as { code?: string }).code ?? "?" : "?");
    }
  }

  assert.deepEqual(codes, [
    "E_INVALID_USER_ID",
    "E_INVALID_DISPLAY_NAME",
    "E_INVALID_ROLE",
    "E_USER_EXISTS",
    "E_INVALID_PASSWORD",
  ]);
  assert.equal(fs.readFileSync(path.join(sandbox.board, "users.yaml"), "utf8"), before);
});

test("a cloned board shows accounts but cannot authenticate them", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  bootstrapAdmin(board, { id: "admin", displayName: "관리자", password: PASSWORD });
  board.close();

  // D5: .local/ is not backed up or shared, so a clone arrives without it.
  fs.rmSync(path.join(sandbox.repo, ".localjira", ".local", "credentials.sqlite"), { force: true });

  const cloned = sandbox.open();
  t.after(() => cloned.close());
  const store = new CredentialStore(cloned.localDirectory);
  t.after(() => store.close());

  assert.deepEqual(listUsers(cloned).map((user) => user.id), ["admin"]);
  const outcome = authenticate(cloned, store, "admin", PASSWORD);
  assert.equal(outcome.user, null);
  assert.equal(
    outcome.reason,
    "no_local_credentials",
    "the operator needs to be told this is a reset, not a wrong password",
  );
});

test("does not reveal whether an account exists", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());
  bootstrapAdmin(board, { id: "admin", displayName: "관리자", password: PASSWORD });

  const store = new CredentialStore(board.localDirectory);
  t.after(() => store.close());

  const unknown = authenticate(board, store, "nobody", PASSWORD);
  const wrong = authenticate(board, store, "admin", "wrong password here");

  assert.equal(unknown.user, null);
  assert.equal(wrong.user, null);
  // Both paths run a real hash so response time cannot enumerate accounts.
  // The distinction exists internally but never reaches an HTTP caller.
  assert.equal(unknown.reason, "unknown_user");
  assert.equal(wrong.reason, "bad_password");
});

// ── sessions ────────────────────────────────────────────────────────────────

test("stores only a hash of the session token", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());
  const store = new CredentialStore(board.localDirectory);
  t.after(() => store.close());

  const session = store.createSession("admin");
  const bytes = fs.readFileSync(path.join(board.localDirectory, "credentials.sqlite"));

  assert.equal(bytes.includes(session.token), false, "a leaked file must not be replayable");
  assert.equal(store.touchSession(session.token)?.userId, "admin");
  assert.equal(store.touchSession("not-a-token"), null);

  store.destroySession(session.token);
  assert.equal(store.touchSession(session.token), null);
});

test("expires a session and slides a live one forward", (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  t.after(() => board.close());
  const store = new CredentialStore(board.localDirectory);
  t.after(() => store.close());

  const start = Date.now();
  const session = store.createSession("admin", start);

  const slid = store.touchSession(session.token, start + 60_000);
  assert.ok(slid && slid.expiresAt > session.expiresAt);

  assert.equal(store.touchSession(session.token, start + 48 * 60 * 60 * 1000), null);
});

// ── HTTP surface ────────────────────────────────────────────────────────────

test("refuses every domain route before bootstrap", async (t) => {
  const sandbox = makeSandbox(t);

  await withServer(sandbox, async (server) => {
    for (const [method, route] of [
      ["GET", "/issues"],
      ["POST", "/issues"],
      ["GET", "/issues/LJ-1"],
      ["GET", "/me"],
    ] as const) {
      const response = await request(server, method, route, {
        body: method === "POST" ? { project: "LJ", type: "story", title: "x" } : undefined,
      });
      assert.equal(response.status, 401, `${method} ${route}`);
      assert.equal(response.json.error.code, "E_BOOTSTRAP_REQUIRED");
    }
  });
});

test("signs in, then serves the domain API", async (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  bootstrapAdmin(board, { id: "admin", displayName: "관리자", password: PASSWORD });
  board.close();

  await withServer(sandbox, async (server) => {
    const anonymous = await request(server, "POST", "/issues", {
      body: { project: "LJ", type: "story", title: "x" },
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.error.code, "E_UNAUTHENTICATED");

    const rejected = await request(server, "POST", "/auth/login", {
      body: { id: "admin", password: "wrong" },
    });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.cookie, null, "a failed login issues no session");
    assert.equal(rejected.json.error.code, "E_INVALID_CREDENTIALS");

    const login = await request(server, "POST", "/auth/login", {
      body: { id: "admin", password: PASSWORD },
    });
    assert.equal(login.status, 200);
    assert.ok(login.cookie);
    assert.match(login.cookie, /HttpOnly/);
    assert.match(login.cookie, /SameSite=Strict/);

    const cookie = login.cookie.split(";")[0];

    const created = await request(server, "POST", "/issues", {
      cookie,
      body: { project: "LJ", type: "story", title: "HTTP로 만든 이슈", points: 3 },
    });
    assert.equal(created.status, 201);
    // A single resource is returned bare so its ETag hashes the response body
    // itself (ADR-003); collections keep an envelope.
    assert.equal(created.json.key, "LJ-1");
    assert.match(created.etag ?? "", /^"[0-9a-f]{64}"$/);

    const listed = await request(server, "GET", "/issues", { cookie });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.issues.length, 1);

    const shown = await request(server, "GET", "/issues/LJ-1", { cookie });
    assert.equal(shown.status, 200);
    assert.equal(shown.etag, created.etag);

    const missing = await request(server, "GET", "/issues/LJ-404", { cookie });
    assert.equal(missing.status, 404);

    const invalid = await request(server, "POST", "/issues", {
      cookie,
      body: { project: "LJ", type: "nope", title: "x" },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, "E_INVALID_TYPE");

    const loggedOut = await request(server, "POST", "/auth/logout", { cookie });
    assert.equal(loggedOut.status, 200);
    const after = await request(server, "GET", "/issues", { cookie });
    assert.equal(after.status, 401, "the session must not survive logout");
  });
});

test("gives the same message for an unknown account and a wrong password", async (t) => {
  const sandbox = makeSandbox(t);
  const board = sandbox.open();
  bootstrapAdmin(board, { id: "admin", displayName: "관리자", password: PASSWORD });
  board.close();

  await withServer(sandbox, async (server) => {
    const unknown = await request(server, "POST", "/auth/login", {
      body: { id: "nobody", password: PASSWORD },
    });
    const wrong = await request(server, "POST", "/auth/login", {
      body: { id: "admin", password: "wrong password here" },
    });

    // Different causes, identical response — otherwise a caller can enumerate
    // which identifiers exist.
    assert.equal(unknown.status, wrong.status);
    assert.deepEqual(unknown.json.error, wrong.json.error);
  });
});

test("bootstraps and lists accounts through the CLI", (t) => {
  const sandbox = makeSandbox(t);

  assert.match(cli(sandbox.repo, ["user", "list"]).stdout, /No accounts yet/);

  const created = cli(sandbox.repo, [
    "admin", "create", "--id", "admin", "--name", "관리자", "--password", PASSWORD, "--json",
  ]);
  assert.equal(created.status, 0, created.stderr);
  const payload = JSON.parse(created.stdout) as { user: { role: string }; bootstrapped: boolean };
  assert.equal(payload.user.role, "admin");
  assert.equal(payload.bootstrapped, true);

  const second = cli(sandbox.repo, [
    "admin", "create", "--id", "dev", "--name", "개발자", "--password", PASSWORD,
    "--role", "member", "--json",
  ]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal((JSON.parse(second.stdout) as { bootstrapped: boolean }).bootstrapped, false);

  assert.match(cli(sandbox.repo, ["user", "list"]).stdout, /admin\s+admin/);

  const short = cli(sandbox.repo, [
    "admin", "create", "--id", "x2", "--name", "짧음", "--password", "tiny",
  ]);
  assert.equal(short.status, 1);
  assert.match(short.stderr, /E_INVALID_PASSWORD/);
});
