import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_AGENT_SCOPES, TOKEN_SCOPES } from "../../src/auth/authorize.ts";
import { startServer, type RunningServer } from "../../src/server/http.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

interface Sandbox {
  repo: string;
  board: string;
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

interface Session {
  server: RunningServer;
  sandbox: Sandbox;
  admin: string;
}

async function session(t: {
  after: (fn: () => void | Promise<void>) => void;
}): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-scope-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
  assert.equal(
    cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]).status,
    0,
  );
  cli(repo, ["admin", "create", "--id", "root", "--name", "루트", "--password", PASSWORD]);
  cli(repo, [
    "admin", "create", "--id", "bot", "--name", "에이전트", "--password", PASSWORD,
    "--role", "agent",
  ]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // A second project, so "another project" is a real place and not a typo.
  const other = path.join(repo, ".localjira", "projects", "OP.yaml");
  fs.writeFileSync(
    other,
    "schema_version: 1\nkey: OP\nname: 다른 프로젝트\ntimezone: UTC\nestimation_unit: story_points\n",
  );

  const server = await startServer({ cwd: repo, port: 0, watch: false });
  t.after(() => server.close());

  const login = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "root", password: PASSWORD }),
  });
  assert.equal(login.status, 200);

  const admin = (login.headers.get("set-cookie") ?? "").split(";")[0];
  await fetch(`${server.url}/index/rebuild`, { method: "POST", headers: { cookie: admin } });

  return { server, sandbox: { repo, board: path.join(repo, ".localjira") }, admin };
}

interface Call {
  status: number;
  json: Record<string, never>;
  etag: string | null;
}

async function call(
  s: Session,
  method: string,
  route: string,
  options: { body?: unknown; cookie?: string; bearer?: string; etag?: string } = {},
): Promise<Call> {
  const response = await fetch(`${s.server.url}${route}`, {
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
    etag: response.headers.get("etag"),
  };
}

async function tokenWith(
  s: Session,
  scopes: string[],
  projectScope: string | null = null,
): Promise<string> {
  const issued = await call(s, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "bot", scopes, ...(projectScope ? { project_scope: projectScope } : {}) },
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.json));
  return issued.json.token as unknown as string;
}

async function anIssue(s: Session, project = "LJ"): Promise<string> {
  const created = await call(s, "POST", "/issues", {
    cookie: s.admin,
    body: { project, type: "task", title: `${project} 이슈` },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.key as unknown as string;
}

function events(sandbox: Sandbox): Array<Record<string, unknown>> {
  const root = path.join(sandbox.board, "events");
  if (!fs.existsSync(root)) {
    return [];
  }
  const found: Array<Record<string, unknown>> = [];
  for (const day of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, day))) {
      for (const line of fs.readFileSync(path.join(root, day, file), "utf8").split("\n")) {
        if (line.trim() !== "") {
          found.push(JSON.parse(line) as Record<string, unknown>);
        }
      }
    }
  }
  return found;
}

function boardFiles(sandbox: Sandbox): Map<string, string> {
  const contents = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".local" || entry.name === ".git" || entry.name === "events") {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else {
        contents.set(absolute, fs.readFileSync(absolute, "utf8"));
      }
    }
  };
  walk(sandbox.board);
  return contents;
}

// ── the seven ───────────────────────────────────────────────────────────────

test("the scopes are exactly the seven the PRD names", () => {
  assert.deepEqual(
    [...TOKEN_SCOPES],
    [
      "issue:read", "issue:comment", "issue:transition", "issue:edit",
      "issue:rank", "run:write", "issue:delete",
    ],
  );

  // D9: reordering the backlog and destroying work are people's decisions. A
  // token gets them only when somebody names them.
  assert.deepEqual(
    [...DEFAULT_AGENT_SCOPES],
    ["issue:read", "issue:comment", "issue:transition", "run:write"],
  );
  assert.equal(DEFAULT_AGENT_SCOPES.includes("issue:rank" as never), false);
  assert.equal(DEFAULT_AGENT_SCOPES.includes("issue:delete" as never), false);
});

// ── refusals ────────────────────────────────────────────────────────────────

test("a narrow token is refused everything its scopes do not name", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  // The AC's example: comment only. Comments themselves are M4, so what is
  // checkable here is the other half — that nothing else opens with it.
  const bearer = await tokenWith(s, ["issue:read", "issue:comment"]);

  const read = await call(s, "GET", `/issues/${key}`, { bearer });
  assert.equal(read.status, 200, "reading is in scope");

  const attempts: Array<[string, string, Call]> = [
    ["전이", "issue:transition", await call(s, "POST", `/issues/${key}/transitions`, {
      bearer, body: { to: "TODO" }, etag: read.etag ?? undefined,
    })],
    ["삭제", "issue:delete", await call(s, "DELETE", `/issues/${key}`, {
      bearer, etag: read.etag ?? undefined,
    })],
    ["순서 변경", "issue:rank", await call(s, "POST", `/issues/${key}/rank`, {
      bearer, body: { field: "backlog_rank", after: null, before: null },
    })],
    ["수정", "issue:edit", await call(s, "PATCH", `/issues/${key}`, {
      bearer, body: { title: "고쳐볼까" }, etag: read.etag ?? undefined,
    })],
  ];

  for (const [label, scope, result] of attempts) {
    assert.equal(result.status, 403, `${label} should be refused`);
    assert.equal(result.json.error?.code, "E_TOKEN_SCOPE", `${label}: ${scope}`);
  }
});

test("a refused request changes no file", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const bearer = await tokenWith(s, ["issue:read"]);
  const before = boardFiles(s.sandbox);

  await call(s, "PATCH", `/issues/${key}`, { bearer, body: { title: "바뀌면 안 됨" } });
  await call(s, "DELETE", `/issues/${key}`, { bearer });

  // A refusal that half-wrote would leave the board in a state nobody asked
  // for and nobody can see, which is worse than either outcome.
  const after = boardFiles(s.sandbox);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [file, text] of after) {
    assert.equal(text, before.get(file), `${path.basename(file)} changed`);
  }
});

test("a token without issue:read cannot list issues", async (t) => {
  const s = await session(t);
  await anIssue(s);
  const bearer = await tokenWith(s, ["run:write"]);

  const listed = await call(s, "GET", "/issues", { bearer });
  assert.equal(listed.status, 403);
  assert.equal(listed.json.error?.code, "E_TOKEN_SCOPE");
});

test("no scope reaches the board's own operation", async (t) => {
  const s = await session(t);
  // §6.4's seven cover using the board, not running it. A token holding every
  // one of them still may not rebuild the index or reshape a sprint.
  const bearer = await tokenWith(s, [...TOKEN_SCOPES]);

  for (const [method, route, body] of [
    ["POST", "/index/rebuild", undefined],
    ["POST", "/index/verify", undefined],
    ["POST", "/projects/LJ/sprints", { name: "에이전트가 만든 스프린트" }],
  ] as const) {
    const result = await call(s, method, route, { bearer, body });
    assert.equal(result.status, 403, `${method} ${route}`);
    assert.equal(result.json.error?.code, "E_TOKEN_SCOPE");
  }
});

// ── project scope ───────────────────────────────────────────────────────────

test("a project-scoped token cannot reach another project", async (t) => {
  const s = await session(t);
  const mine = await anIssue(s, "LJ");
  const theirs = await anIssue(s, "OP");
  const bearer = await tokenWith(s, ["issue:read", "issue:edit"], "LJ");

  assert.equal((await call(s, "GET", `/issues/${mine}`, { bearer })).status, 200);

  const forbidden = await call(s, "GET", `/issues/${theirs}`, { bearer });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.error?.code, "E_PROJECT_SCOPE");
  // The refusal must not be a leak of its own: no title, no fields.
  assert.equal(JSON.stringify(forbidden.json).includes("OP 이슈"), false);

  const write = await call(s, "PATCH", `/issues/${theirs}`, {
    bearer, body: { title: "남의 프로젝트" },
  });
  assert.equal(write.status, 403);
});

test("a listing shows the token's project and no other", async (t) => {
  const s = await session(t);
  await anIssue(s, "LJ");
  await anIssue(s, "OP");
  const bearer = await tokenWith(s, ["issue:read"], "LJ");

  // S3-D9: narrowed rather than refused — a collection names no project, and
  // an agent asking what work exists should be answered.
  const listed = await call(s, "GET", "/issues", { bearer });
  assert.equal(listed.status, 200);
  const projects = new Set(
    (listed.json.issues as unknown as Array<{ key: string }>).map((issue) => issue.key.split("-")[0]),
  );
  assert.deepEqual([...projects], ["LJ"]);

  // And asking for the other one returns that project's nothing, not everything.
  const asked = await call(s, "GET", "/issues?project=OP", { bearer });
  assert.equal((asked.json.issues as unknown as unknown[]).length, 1);
  assert.equal(
    (asked.json.issues as unknown as Array<{ key: string }>)[0].key.startsWith("LJ-"),
    true,
  );
});

// ── claim coupling (§6.1) ───────────────────────────────────────────────────

test("issue:transition alone does not let an agent start work", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const bearer = await tokenWith(s, ["issue:read", "issue:transition"]);
  const read = await call(s, "GET", `/issues/${key}`, { bearer });

  const started = await call(s, "POST", `/issues/${key}/transitions`, {
    bearer, body: { to: "TODO" }, etag: read.etag ?? undefined,
  });
  assert.equal(started.status, 200, "TODO is not claim-gated");

  for (const to of ["IN_PROGRESS", "IN_REVIEW", "DONE"]) {
    const current = await call(s, "GET", `/issues/${key}`, { bearer });
    const attempt = await call(s, "POST", `/issues/${key}/transitions`, {
      bearer, body: { to }, etag: current.etag ?? undefined,
    });
    // AC19: scope is not a sufficient condition. Two agents holding it would
    // otherwise both start the same issue.
    assert.equal(attempt.status, 403, `${to} without a claim`);
    assert.equal(attempt.json.error?.code, "E_CLAIM_REQUIRED");
  }
});

test("a person moves the same issue without a claim", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);

  // §6.1 judges people by role, not scope, and does not ask them to claim.
  for (const to of ["TODO", "IN_PROGRESS"]) {
    const current = await call(s, "GET", `/issues/${key}`, { cookie: s.admin });
    const moved = await call(s, "POST", `/issues/${key}/transitions`, {
      cookie: s.admin, body: { to }, etag: current.etag ?? undefined,
    });
    assert.equal(moved.status, 200, `${to} as a person`);
  }
});

// ── audit ───────────────────────────────────────────────────────────────────

test("success and refusal are both recorded against the token", async (t) => {
  const s = await session(t);
  const key = await anIssue(s);
  const issued = await call(s, "POST", "/tokens", {
    cookie: s.admin,
    body: { user: "bot", scopes: ["issue:read", "issue:edit"] },
  });
  const bearer = issued.json.token as unknown as string;
  const tokenId = issued.json.token_id as unknown as string;

  const read = await call(s, "GET", `/issues/${key}`, { bearer });
  const edited = await call(s, "PATCH", `/issues/${key}`, {
    bearer, body: { title: "토큰이 고친 제목" }, etag: read.etag ?? undefined,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));

  const denied = await call(s, "DELETE", `/issues/${key}`, { bearer, etag: edited.etag ?? undefined });
  assert.equal(denied.status, 403);

  const recorded = events(s.sandbox);
  const success = recorded.find((event) => event.verb === "issue.updated");
  const refusal = recorded.find((event) => event.verb === "access.denied");

  // AC16 names both halves. A trail that only holds refusals cannot answer
  // "what did this token actually change".
  assert.equal(success?.token_id, tokenId, "the successful write names the token");
  assert.equal(refusal?.token_id, tokenId, "and so does the refusal");
  assert.equal(success?.actor_kind, "agent");

  const text = JSON.stringify(recorded);
  assert.equal(text.includes(bearer), false, "and never the token itself");
});

test("reading is not audited, refused or not", async (t) => {
  const s = await session(t);
  await anIssue(s);
  const bearer = await tokenWith(s, ["run:write"]);
  const before = events(s.sandbox).length;

  for (let index = 0; index < 3; index += 1) {
    assert.equal((await call(s, "GET", "/issues", { bearer })).status, 403);
  }

  // N7 excludes reads and searches. An agent polling a route it cannot use
  // would otherwise become the loudest writer on the board.
  assert.equal(events(s.sandbox).length, before);
});
