import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer, type RunningServer } from "../../src/server/http.ts";
import { LEASE_MS, RuntimeStore } from "../../src/storage/runtime.ts";
import { STALE_AFTER_MS } from "../../src/domain/run.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

interface Session {
  server: RunningServer;
  repo: string;
  board: string;
  local: string;
  admin: string;
  /** Bearer for `bot`, holding the default agent scopes. */
  bot: string;
  /** Bearer for `bot2`, a second agent racing for the same work. */
  bot2: string;
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

interface Result {
  status: number;
  json: Record<string, never>;
  etag: string | null;
  headers: Headers;
}

async function call(
  s: Session,
  method: string,
  route: string,
  options: { body?: unknown; cookie?: string; bearer?: string; etag?: string } = {},
): Promise<Result> {
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
    headers: response.headers,
  };
}

async function session(t: {
  after: (fn: () => void | Promise<void>) => void;
}): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-claim-")));
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
  for (const id of ["bot", "bot2"]) {
    cli(repo, [
      "admin", "create", "--id", id, "--name", id, "--password", PASSWORD, "--role", "agent",
    ]);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const server = await startServer({ cwd: repo, port: 0, watch: false });
  t.after(() => server.close());

  const login = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "root", password: PASSWORD }),
  });
  const admin = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const partial: Session = {
    server, repo,
    board: path.join(repo, ".localjira"),
    local: path.join(repo, ".localjira", ".local"),
    admin, bot: "", bot2: "",
  };

  for (const id of ["bot", "bot2"] as const) {
    const issued = await call(partial, "POST", "/tokens", { cookie: admin, body: { user: id } });
    assert.equal(issued.status, 201, JSON.stringify(issued.json));
    partial[id] = issued.json.token as unknown as string;
  }
  return partial;
}

/** The five fields §6.2 requires when a run reports (r17b). */
const RESULT = {
  summary: "링크 검증을 고쳤다",
  verification: { method: "npm test", outcome: "passed" },
  files_changed: ["src/domain/links.ts"],
  commits: ["abc1234"],
  remaining_risks: "없음",
};

/** A TODO issue, which is what an agent may claim (§6.1). */
async function refinedIssue(s: Session, title = "집을 수 있는 일"): Promise<string> {
  const created = await call(s, "POST", "/issues", {
    cookie: s.admin, body: { project: "LJ", type: "task", title },
  });
  const key = created.json.key as unknown as string;
  const current = await call(s, "GET", `/issues/${key}`, { cookie: s.admin });
  const moved = await call(s, "POST", `/issues/${key}/transitions`, {
    cookie: s.admin, etag: current.etag ?? undefined, body: { to: "TODO" },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  return key;
}

async function startRun(s: Session, issue: string, bearer: string, agentId: string): Promise<string> {
  const started = await call(s, "POST", "/runs", {
    bearer,
    body: {
      issue,
      session_id: `sess-${agentId}`,
      agent_id: agentId,
      initiated_by: "root",
      branch: `feat/${agentId}`,
    },
  });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  return started.json.run_id as unknown as string;
}

function events(s: Session, verb: string): Array<Record<string, unknown>> {
  const root = path.join(s.board, "events");
  if (!fs.existsSync(root)) {
    return [];
  }
  const found: Array<Record<string, unknown>> = [];
  for (const day of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, day))) {
      for (const line of fs.readFileSync(path.join(root, day, file), "utf8").split("\n")) {
        if (line.trim() !== "") {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.verb === verb) {
            found.push(event);
          }
        }
      }
    }
  }
  return found;
}

// ── runs (r17a) ─────────────────────────────────────────────────────────────

test("a run registers its session, agent, director and branch", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);

  const started = await call(s, "POST", "/runs", {
    bearer: s.bot,
    body: {
      issue: key, session_id: "sess-1", agent_id: "bot",
      initiated_by: "root", branch: "feat/thing",
    },
  });
  assert.equal(started.status, 201);
  assert.match(started.json.run_id as unknown as string, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(started.json.state, "RUNNING");
  assert.equal(started.json.stale, false);

  // §6.2 delegation: both who ran it and who asked for it.
  assert.equal(started.json.agent_id, "bot");
  assert.equal(started.json.initiated_by, "root");

  // File SoT, unlike the claim it will hold (ADR-004 §1).
  const files = fs
    .readdirSync(path.join(s.board, "runs", "LJ"), { recursive: true } as never)
    .filter((entry) => String(entry).endsWith(".json"));
  assert.equal(files.length, 1, JSON.stringify(files));

  const recorded = events(s, "run.started");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].run_id, started.json.run_id);
  assert.equal(recorded[0].actor_kind, "agent");
});

test("a run missing any of the four is refused", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const full = {
    issue: key, session_id: "sess-1", agent_id: "bot",
    initiated_by: "root", branch: "feat/thing",
  };

  for (const field of ["session_id", "agent_id", "initiated_by", "branch"] as const) {
    const body = { ...full, [field]: "" };
    const attempt = await call(s, "POST", "/runs", { bearer: s.bot, body });
    // §6.2 names all four as registered. Defaulting one would produce a record
    // that cannot answer the question it exists to answer.
    assert.equal(attempt.status, 400, `missing ${field}`);
    assert.equal(attempt.json.error?.code, "E_RUN_FIELD_MISSING");
  }

  assert.equal(fs.existsSync(path.join(s.board, "runs")), false, "and nothing was written");
});

test("a token without run:write cannot start a run", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const issued = await call(s, "POST", "/tokens", {
    cookie: s.admin, body: { user: "bot", scopes: ["issue:read", "issue:transition"] },
  });

  const attempt = await call(s, "POST", "/runs", {
    bearer: issued.json.token as unknown as string,
    body: {
      issue: key, session_id: "s", agent_id: "bot", initiated_by: "root", branch: "b",
    },
  });
  assert.equal(attempt.status, 403);
  assert.equal(attempt.json.error?.code, "E_TOKEN_SCOPE");
});

test("the same Idempotency-Key does not start a second run", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const body = {
    issue: key, session_id: "s", agent_id: "bot", initiated_by: "root", branch: "b",
  };

  const first = await fetch(`${s.server.url}/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${s.bot}`,
      "idempotency-key": "K",
    },
    body: JSON.stringify(body),
  });
  const again = await fetch(`${s.server.url}/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${s.bot}`,
      "idempotency-key": "K",
    },
    body: JSON.stringify(body),
  });

  // r15's wrapper, now on this route too — that half of r15 AC1 closes here.
  assert.equal(first.status, 201);
  assert.equal(await again.text(), await first.text());
  const files = fs
    .readdirSync(path.join(s.board, "runs", "LJ"), { recursive: true } as never)
    .filter((entry) => String(entry).endsWith(".json"));
  assert.equal(files.length, 1);
});

test("STALE is computed, not stored", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");

  const fresh = await call(s, "GET", `/runs/${runId}`, { bearer: s.bot });
  assert.equal(fresh.json.stale, false);
  assert.equal(fresh.json.state, "RUNNING");

  // Backdate the heartbeat in the file. Nothing sweeps and nothing recalculates
  // — the answer changes because it is derived from the clock (ADR-004 §3).
  const runFile = fs
    .readdirSync(path.join(s.board, "runs", "LJ"), { recursive: true } as never)
    .map((entry) => path.join(s.board, "runs", "LJ", String(entry)))
    .find((entry) => entry.endsWith(".json"))!;
  const stored = JSON.parse(fs.readFileSync(runFile, "utf8")) as Record<string, unknown>;
  assert.equal("stale" in stored, false, "the file holds no such field");
  stored.last_heartbeat_at = new Date(Date.now() - STALE_AFTER_MS - 1_000).toISOString();
  fs.writeFileSync(runFile, JSON.stringify(stored));
  await call(s, "POST", "/index/rebuild", { cookie: s.admin });

  const later = await call(s, "GET", `/runs/${runId}`, { bearer: s.bot });
  assert.equal(later.json.stale, true);
  assert.equal(later.json.state, "RUNNING", "still running, only late");
});

test("a heartbeat renews the claim's lease as well", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });

  const runtime = new RuntimeStore(s.local);
  const before = runtime.findByRun(runId)!.leaseExpiresAt;
  runtime.close();

  // A whole second, so a renewed lease is visibly later rather than equal.
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  const beat = await call(s, "POST", `/runs/${runId}/heartbeat`, { bearer: s.bot });
  assert.equal(beat.status, 200);

  // S3-D3: one signal moves both. A run reporting alive while its claim expires
  // is the state the single endpoint exists to make impossible.
  const after = Date.parse((beat.json.claim as unknown as { lease_expires_at: string }).lease_expires_at);
  assert.ok(after > before, `${after} should be past ${before}`);
});

test("an ended run stops reporting and lets go of its claim", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });

  const ended = await call(s, "POST", `/runs/${runId}/end`, {
    bearer: s.bot, body: { state: "DONE", result: RESULT },
  });
  assert.equal(ended.status, 200, JSON.stringify(ended.json));
  assert.equal(ended.json.state, "DONE");

  const late = await call(s, "POST", `/runs/${runId}/heartbeat`, { bearer: s.bot });
  assert.equal(late.status, 409, "a finished run cannot come back");

  // Another agent can now take the issue: an ended session holding it is the
  // ghost occupancy ADR-004 exists to prevent.
  const other = await startRun(s, key, s.bot2, "bot2");
  const taken = await call(s, "POST", `/issues/${key}/claim`, {
    bearer: s.bot2, body: { run_id: other },
  });
  assert.equal(taken.status, 200, JSON.stringify(taken.json));
});

test("only the agent that started a run may report on it", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");

  // Otherwise any token with run:write could end another agent's run, and with
  // it release the claim that run holds.
  const beat = await call(s, "POST", `/runs/${runId}/heartbeat`, { bearer: s.bot2 });
  assert.equal(beat.status, 403);
  const ended = await call(s, "POST", `/runs/${runId}/end`, {
    bearer: s.bot2, body: { state: "DONE", result: RESULT },
  });
  assert.equal(ended.status, 403);
});

// ── claims (r16a) ───────────────────────────────────────────────────────────

test("two agents claiming at once: exactly one wins", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const mine = await startRun(s, key, s.bot, "bot");
  const theirs = await startRun(s, key, s.bot2, "bot2");

  // Fired together, not one after the other. AC2 rules out a read followed by a
  // write, and a sequential test cannot tell the two designs apart.
  const [first, second] = await Promise.all([
    call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: mine } }),
    call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot2, body: { run_id: theirs } }),
  ]);

  const codes = [first.status, second.status].sort();
  assert.deepEqual(codes, [200, 409], JSON.stringify([first.json, second.json]));

  const refused = first.status === 409 ? first : second;
  assert.equal(refused.json.error?.code, "E_CLAIM_HELD");
  // An agent told 409 has to decide whether to wait, which needs both of these.
  assert.ok(refused.json.owner_id, "the refusal says who holds it");
  assert.ok(refused.json.lease_expires_at, "and until when");

  assert.equal(events(s, "claim.acquired").length, 1, "one acquisition, one event");
});

test("six processes racing for one claim: exactly one gets it", async (t) => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "localjira-race2-"));
  t.after(() => fs.rmSync(local, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL("../fixtures/claim-race.ts", import.meta.url));

  // Six processes and ten rounds, chosen by measurement rather than by feel: at
  // two processes a read-then-write implementation still passed most runs,
  // because the first write usually lands before the second read. At six it
  // failed six times out of six, while the real implementation passes. A race
  // test that only sometimes catches the thing it exists to catch is worse than
  // none — it reports green and means nothing.
  for (let round = 0; round < 10; round += 1) {
    const uid = `01JRACE${String(round).padStart(4, "0")}`;
    const startAt = Date.now() + 120;

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, index) => [`bot${index}`, `run-${index}`]).map(([owner, run]) =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [fixture, local, uid, owner, run, String(startAt)],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let out = "";
          let err = "";
          child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
          child.on("close", (code) =>
            code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`)),
          );
        }),
      ),
    );

    // AC2: exactly one. Two processes *can* both pass a read before either
    // writes, so a design that reads and then writes fails here — which is the
    // whole point of paying for child processes.
    assert.equal(
      outcomes.filter((outcome) => outcome === "acquired").length,
      1,
      `round ${round}: ${outcomes.join(" / ")}`,
    );
  }
});

test("the primary key is what decides, across connections", (t) => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "localjira-race-"));
  // Two connections to one file, which is as concurrent as SQLite gets here.
  // If the decision were a read then a write, both would pass the read.
  const a = new RuntimeStore(local);
  const b = new RuntimeStore(local);
  t.after(() => {
    a.close();
    b.close();
    fs.rmSync(local, { recursive: true, force: true });
  });

  const first = a.acquire("01JISSUE", "bot", "run-1");
  const second = b.acquire("01JISSUE", "bot2", "run-2");

  assert.equal(first.outcome, "acquired");
  assert.equal(second.outcome, "held");
  assert.equal(second.outcome === "held" && second.by.ownerId, "bot");
});

test("a third agent is refused with who holds it", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const mine = await startRun(s, key, s.bot, "bot");
  const theirs = await startRun(s, key, s.bot2, "bot2");

  assert.equal(
    (await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: mine } }))
      .status,
    200,
  );
  const refused = await call(s, "POST", `/issues/${key}/claim`, {
    bearer: s.bot2, body: { run_id: theirs },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.owner_id, "bot");
});

test("the same run asking again renews rather than conflicts", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");

  const first = await call(s, "POST", `/issues/${key}/claim`, {
    bearer: s.bot, body: { run_id: runId },
  });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const again = await call(s, "POST", `/issues/${key}/claim`, {
    bearer: s.bot, body: { run_id: runId },
  });

  // D10: the same owner and run is a renewal, not a collision. 200 both times,
  // and no second event for something that did not happen twice.
  assert.equal(again.status, 200);
  assert.ok(
    Date.parse(again.json.lease_expires_at as unknown as string) >
      Date.parse(first.json.lease_expires_at as unknown as string),
  );
  assert.equal(events(s, "claim.acquired").length, 1);
});

test("a backlog item is refused, with its own reason", async (t) => {
  const s = await session(t);
  const created = await call(s, "POST", "/issues", {
    cookie: s.admin, body: { project: "LJ", type: "task", title: "정제 안 된 일" },
  });
  const key = created.json.key as unknown as string;
  const runId = await startRun(s, key, s.bot, "bot");

  const refused = await call(s, "POST", `/issues/${key}/claim`, {
    bearer: s.bot, body: { run_id: runId },
  });

  // S3-D5: 409 with its own code. 403 would read as a permission problem and
  // 400 as a malformed request; this is "not yet, and here is what would change
  // it" — a person moves it to TODO.
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error?.code, "E_CLAIM_NOT_REFINED");
});

test("an issue waiting on another is refused, and says which", async (t) => {
  const s = await session(t);
  const blocker = await refinedIssue(s, "선행");
  const blocked = await refinedIssue(s, "후행");

  const detail = await call(s, "GET", `/issues/${blocked}`, { cookie: s.admin });
  const blockerDetail = await call(s, "GET", `/issues/${blocker}`, { cookie: s.admin });
  await call(s, "POST", `/issues/${blocked}/links`, {
    cookie: s.admin,
    etag: detail.etag ?? undefined,
    body: { kind: "blocked_by", to: blockerDetail.json.uid },
  });

  const runId = await startRun(s, blocked, s.bot, "bot");
  const refused = await call(s, "POST", `/issues/${blocked}/claim`, {
    bearer: s.bot, body: { run_id: runId },
  });

  assert.equal(refused.status, 409);
  assert.equal(refused.json.error?.code, "E_CLAIM_BLOCKED");
  // The reason travels with the refusal: an agent has to be able to report why.
  assert.deepEqual(refused.json.blocked_by, [blocker]);

  const listed = await call(s, "GET", `/issues/${blocked}`, { bearer: s.bot });
  assert.equal(listed.headers.get("x-claimable"), "false");
  assert.equal(listed.headers.get("x-blocked-by"), blocker);
});

test("a claim needs a run, and the run has to be for this issue", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const other = await refinedIssue(s, "다른 일");

  // ADR-004 §2: no ownership through a placeholder run.
  const none = await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: {} });
  assert.equal(none.status, 409);
  assert.equal(none.json.error?.code, "E_RUN_REQUIRED");

  const unknown = await call(s, "POST", `/issues/${key}/claim`, {
    bearer: s.bot, body: { run_id: "01JNOTAREALRUN0000000000AA" },
  });
  assert.equal(unknown.status, 404);

  const elsewhere = await startRun(s, other, s.bot, "bot");
  const mismatched = await call(s, "POST", `/issues/${key}/claim`, {
    bearer: s.bot, body: { run_id: elsewhere },
  });
  assert.equal(mismatched.status, 409);
  assert.equal(mismatched.json.error?.code, "E_RUN_OTHER_ISSUE");
});

test("an expired lease is recoverable by the next asker", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const mine = await startRun(s, key, s.bot, "bot");
  const theirs = await startRun(s, key, s.bot2, "bot2");
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: mine } });

  const blocked = await call(s, "POST", `/issues/${key}/claim`, {
    bearer: s.bot2, body: { run_id: theirs },
  });
  assert.equal(blocked.status, 409);

  // Age the lease out. AC20: an expired claim is recoverable, and by whoever
  // asks next rather than by whatever happens to sweep.
  const runtime = new RuntimeStore(s.local);
  const claim = runtime.findByRun(mine)!;
  runtime.acquire(claim.issueUid, "bot", mine, Date.now() - LEASE_MS - 1_000);
  runtime.close();

  const taken = await call(s, "POST", `/issues/${key}/claim`, {
    bearer: s.bot2, body: { run_id: theirs },
  });
  assert.equal(taken.status, 200, JSON.stringify(taken.json));
  assert.equal(taken.json.owner_id, "bot2");
});

// ── claim ↔ transition (§6.1) ───────────────────────────────────────────────

test("a claim is what opens the three gated transitions", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");

  const before = await call(s, "GET", `/issues/${key}`, { bearer: s.bot });
  const refused = await call(s, "POST", `/issues/${key}/transitions`, {
    bearer: s.bot, etag: before.etag ?? undefined, body: { to: "IN_PROGRESS" },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error?.code, "E_CLAIM_REQUIRED");

  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });

  const current = await call(s, "GET", `/issues/${key}`, { bearer: s.bot });
  const allowed = await call(s, "POST", `/issues/${key}/transitions`, {
    bearer: s.bot, etag: current.etag ?? undefined, body: { to: "IN_PROGRESS" },
  });
  // r13b AC8, which could not close until claims existed.
  assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
  assert.equal(allowed.json.status, "IN_PROGRESS");
});

test("somebody else's claim does not open them", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const mine = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: mine } });

  const current = await call(s, "GET", `/issues/${key}`, { bearer: s.bot2 });
  const attempt = await call(s, "POST", `/issues/${key}/transitions`, {
    bearer: s.bot2, etag: current.etag ?? undefined, body: { to: "IN_PROGRESS" },
  });
  assert.equal(attempt.status, 403);
  assert.equal(attempt.json.error?.code, "E_CLAIM_REQUIRED");
});

test("a claim does not widen the transition table", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });

  const current = await call(s, "GET", `/issues/${key}`, { bearer: s.bot });
  const attempt = await call(s, "POST", `/issues/${key}/transitions`, {
    bearer: s.bot, etag: current.etag ?? undefined, body: { to: "DONE" },
  });
  // AC14: TODO → DONE is not in §5.2, and holding a claim does not add it.
  assert.equal(attempt.status, 400, JSON.stringify(attempt.json));
});

// ── the listing (AC9) ───────────────────────────────────────────────────────

test("a claimable listing holds nothing already taken", async (t) => {
  const s = await session(t);
  const free = await refinedIssue(s, "빈 일");
  const taken = await refinedIssue(s, "잡힌 일");
  const runId = await startRun(s, taken, s.bot, "bot");
  await call(s, "POST", `/issues/${taken}/claim`, { bearer: s.bot, body: { run_id: runId } });

  const listed = await call(s, "GET", "/issues?claimable=true", { bearer: s.bot });
  const keys = (listed.json.issues as unknown as Array<{ key: string }>).map((i) => i.key);

  assert.ok(keys.includes(free), keys.join(", "));
  assert.equal(keys.includes(taken), false, "an issue under a live claim is not free work");
});

// ── runtime, not history ────────────────────────────────────────────────────

test("the claim is runtime state; that it happened is history", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });

  // §5.3, §5.4: the claim itself is in `.local/`, which git does not track.
  assert.ok(fs.existsSync(path.join(s.local, "runtime.sqlite")));
  const tracked = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: s.board, encoding: "utf8",
  }).stdout;
  assert.equal(tracked.includes(".local/"), false, tracked);

  // But the fact is an event, so the history survives losing the runtime store.
  assert.equal(events(s, "claim.acquired").length, 1);
});

test("a restart keeps a live claim and reclaims an expired one", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });
  await s.server.close();

  // A server restarting must not cost a working agent its place (§5.4).
  const again = await startServer({ cwd: s.repo, port: 0, watch: false });
  const live = { ...s, server: again };
  const held = await call(live, "GET", `/issues/${key}`, { bearer: s.bot });
  assert.equal(held.headers.get("x-claim-owner"), "bot");
  await again.close();

  // And a lease that ran out while nothing was watching must not survive.
  const runtime = new RuntimeStore(s.local);
  const claim = runtime.findByRun(runId)!;
  runtime.acquire(claim.issueUid, "bot", runId, Date.now() - LEASE_MS - 1_000);
  runtime.close();

  const third = await startServer({ cwd: s.repo, port: 0, watch: false });
  const after = { ...s, server: third };
  const gone = await call(after, "GET", `/issues/${key}`, { bearer: s.bot });
  assert.equal(gone.headers.get("x-claim-owner"), null);
  await third.close();
});

// ── lease and forced release (r16b) ─────────────────────────────────────────

test("a person takes a claim back, and the run it held stops writing", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });

  const released = await call(s, "DELETE", `/issues/${key}/claim`, {
    cookie: s.admin, body: { reason: "다른 사람이 이어받기로 했다" },
  });
  assert.equal(released.status, 200, JSON.stringify(released.json));
  assert.equal(released.json.released, true);

  // AC20: every later write from that run is refused. Leaving it RUNNING would
  // let it keep moving an issue it no longer holds.
  const beat = await call(s, "POST", `/runs/${runId}/heartbeat`, { bearer: s.bot });
  assert.equal(beat.status, 409);
  const ended = await call(s, "POST", `/runs/${runId}/end`, {
    bearer: s.bot, body: { state: "DONE", result: RESULT },
  });
  assert.equal(ended.status, 409);

  const current = await call(s, "GET", `/issues/${key}`, { bearer: s.bot });
  const moved = await call(s, "POST", `/issues/${key}/transitions`, {
    bearer: s.bot, etag: current.etag ?? undefined, body: { to: "IN_PROGRESS" },
  });
  assert.equal(moved.status, 403, "and the claim is gone, so the gate is shut again");
});

test("the release says who did it and why", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });
  await call(s, "DELETE", `/issues/${key}/claim`, {
    cookie: s.admin, body: { reason: "빌드가 멈춰 있었다" },
  });

  const [event] = events(s, "claim.released");
  assert.ok(event, "the intervention is on the record");
  assert.equal(event.actor_id, "root");
  assert.equal((event.after as Record<string, unknown>).reason, "빌드가 멈춰 있었다");
  assert.equal((event.after as Record<string, unknown>).owner_id, "bot");
});

test("an agent may not take another agent's claim", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });

  // D7 puts people last in the chain. Two agents releasing each other would be
  // an argument with no referee.
  const attempt = await call(s, "DELETE", `/issues/${key}/claim`, { bearer: s.bot2 });
  assert.equal(attempt.status, 403);

  const still = await call(s, "GET", `/issues/${key}`, { bearer: s.bot });
  assert.equal(still.headers.get("x-claim-owner"), "bot");
});

test("releasing an issue nobody holds is not an error", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const released = await call(s, "DELETE", `/issues/${key}/claim`, { cookie: s.admin });

  // The caller's goal — nobody is holding it — already holds. A 404 would make
  // a person check whether they had broken something.
  assert.equal(released.status, 200);
  assert.equal(released.json.released, false);
  assert.equal(events(s, "claim.released").length, 0, "and nothing is invented for the log");
});

test("the issue's status is left where the agent left it", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });

  const before = await call(s, "GET", `/issues/${key}`, { bearer: s.bot });
  await call(s, "POST", `/issues/${key}/transitions`, {
    bearer: s.bot, etag: before.etag ?? undefined, body: { to: "IN_PROGRESS" },
  });
  await call(s, "DELETE", `/issues/${key}/claim`, { cookie: s.admin });

  // ADR-004 §3: no automatic rewind. The work that happened happened, and what
  // to do about it is the person's call — the one who just intervened.
  const after = await call(s, "GET", `/issues/${key}`, { cookie: s.admin });
  assert.equal(after.json.status, "IN_PROGRESS");
});

test("a lease that ran out is reclaimed by the system, not by whoever asked next", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });
  await s.server.close();

  const runtime = new RuntimeStore(s.local);
  const claim = runtime.findByRun(runId)!;
  runtime.acquire(claim.issueUid, "bot", runId, Date.now() - LEASE_MS - 1_000);
  runtime.close();

  const again = await startServer({ cwd: s.repo, port: 0, watch: false });
  await again.close();

  const [event] = events(s, "claim.reclaimed");
  assert.ok(event, "expiry is recorded, or the history has a hole where a claim was");
  // Nobody decided this; the clock did. Naming a person would put an action on
  // their record that they did not take (§5.1).
  assert.equal(event.actor_kind, "system");
  assert.equal((event.after as Record<string, unknown>).reason, "lease expired");
});

// ── structured results (r17b) ───────────────────────────────────────────────

test("all five fields are required, and prose is not one of them", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");

  // AC3: a single free-text field is exactly what the five exist to replace.
  const prose = await call(s, "POST", `/runs/${runId}/end`, {
    bearer: s.bot, body: { state: "DONE", result: "다 했습니다" },
  });
  assert.equal(prose.status, 400);
  assert.equal(prose.json.error?.code, "E_RESULT_SHAPE");

  for (const field of [
    "summary", "verification", "files_changed", "commits", "remaining_risks",
  ] as const) {
    const partial: Record<string, unknown> = { ...RESULT };
    delete partial[field];
    const attempt = await call(s, "POST", `/runs/${runId}/end`, {
      bearer: s.bot, body: { state: "DONE", result: partial },
    });
    assert.equal(attempt.status, 400, `missing ${field}`);

    // AC2: and the run is not ended, so a corrected submission can still land.
    const still = await call(s, "GET", `/runs/${runId}`, { bearer: s.bot });
    assert.equal(still.json.state, "RUNNING", `${field} left the run ended`);
  }
});

test("not verifying is something a run has to say", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");

  // A boolean has no room for "I did not check", so the outcome is an enum and
  // `method` stays required beside it (S3-D6, AC4).
  const missing = await call(s, "POST", `/runs/${runId}/end`, {
    bearer: s.bot,
    body: { state: "DONE", result: { ...RESULT, verification: { outcome: "skipped" } } },
  });
  assert.equal(missing.status, 400);

  const said = await call(s, "POST", `/runs/${runId}/end`, {
    bearer: s.bot,
    body: {
      state: "DONE",
      result: {
        ...RESULT,
        verification: { method: "시간이 없어 돌리지 못함", outcome: "skipped" },
      },
    },
  });
  assert.equal(said.status, 200, JSON.stringify(said.json));
  assert.equal(
    (said.json.result as unknown as { verification: { outcome: string } }).verification.outcome,
    "skipped",
  );
});

test("the result is in the file and survives losing the index", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/runs/${runId}/end`, {
    bearer: s.bot, body: { state: "DONE", result: RESULT },
  });

  const before = await call(s, "GET", `/runs/${runId}`, { bearer: s.bot });
  await call(s, "POST", "/index/rebuild", { cookie: s.admin });
  const after = await call(s, "GET", `/runs/${runId}`, { bearer: s.bot });

  // AC2/G4: the index is derived, so nothing of the report may live only there.
  assert.deepEqual(after.json.result, before.json.result);
  assert.deepEqual(after.json.result, RESULT);
});

test("a run that was cancelled cannot report at all", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/issues/${key}/claim`, { bearer: s.bot, body: { run_id: runId } });
  await call(s, "DELETE", `/issues/${key}/claim`, { cookie: s.admin, body: { reason: "회수" } });

  const late = await call(s, "POST", `/runs/${runId}/end`, {
    bearer: s.bot, body: { state: "DONE", result: RESULT },
  });
  assert.equal(late.status, 409);

  const stored = await call(s, "GET", `/runs/${runId}`, { bearer: s.bot });
  assert.equal(stored.json.state, "CANCELLED");
  assert.equal(stored.json.result, null, "and nothing was kept from the refused submission");
});

test("a finished report is told apart from a run that never made one", async (t) => {
  const s = await session(t);
  const reported = await refinedIssue(s, "보고한 일");
  const silent = await refinedIssue(s, "말없이 끝난 일");

  const good = await startRun(s, reported, s.bot, "bot");
  await call(s, "POST", `/runs/${good}/end`, {
    bearer: s.bot, body: { state: "DONE", result: RESULT },
  });

  // The run that never reported is the one that could not: it was taken away
  // mid-flight. An agent that is still running cannot end itself without the
  // five fields, so "ended with nothing to say" only happens from outside.
  const bad = await startRun(s, silent, s.bot, "bot");
  await call(s, "POST", `/issues/${silent}/claim`, { bearer: s.bot, body: { run_id: bad } });
  await call(s, "DELETE", `/issues/${silent}/claim`, { cookie: s.admin, body: { reason: "멈춤" } });

  // AC10: "끝났다"와 "끝났는데 아무 말도 없다"가 같아 보이면 S5의 회수 대상을 눈으로
  // 찾을 수 없다.
  const first = await call(s, "GET", `/runs/${good}`, { bearer: s.bot });
  const second = await call(s, "GET", `/runs/${bad}`, { bearer: s.bot });
  assert.equal(first.json.state, "DONE");
  assert.notEqual(first.json.result, null);
  assert.equal(second.json.state, "CANCELLED");
  assert.equal(second.json.result, null);

  // The flag the screen reads, on both endpoints. The detail panel showed a run
  // that had reported as one that had not, because only the card carried it.
  assert.equal(first.json.has_result, true);
  assert.equal(second.json.has_result, false);

  // And the board says so without anyone opening the run.
  const board = await call(s, "GET", "/projects/LJ/board", { cookie: s.admin });
  void board;
});

test("a failure is still a report", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");

  // "실패했습니다" on its own is the "다 했습니다" of failures. An agent that is
  // alive enough to say it failed is alive enough to say what it tried.
  const bare = await call(s, "POST", `/runs/${runId}/end`, {
    bearer: s.bot, body: { state: "FAILED" },
  });
  assert.equal(bare.status, 400);

  const told = await call(s, "POST", `/runs/${runId}/end`, {
    bearer: s.bot,
    body: {
      state: "FAILED",
      result: { ...RESULT, verification: { method: "npm test", outcome: "failed" } },
    },
  });
  assert.equal(told.status, 200, JSON.stringify(told.json));
  assert.equal(told.json.state, "FAILED");
});

test("submitting a result is recorded against the agent and its director", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  await call(s, "POST", `/runs/${runId}/end`, {
    bearer: s.bot, body: { state: "DONE", result: RESULT },
  });

  const [event] = events(s, "run.ended");
  assert.ok(event);
  assert.equal(event.actor_kind, "agent");
  assert.equal(event.run_id, runId);
  // §6.2 delegation: the record names both, or an agent's report reads as the
  // director's own work.
  assert.equal(event.initiated_by, "root");
});

test("a run without run:write cannot submit", async (t) => {
  const s = await session(t);
  const key = await refinedIssue(s);
  const runId = await startRun(s, key, s.bot, "bot");
  const narrow = await call(s, "POST", "/tokens", {
    cookie: s.admin, body: { user: "bot", scopes: ["issue:read"] },
  });

  const attempt = await call(s, "POST", `/runs/${runId}/end`, {
    bearer: narrow.json.token as unknown as string,
    body: { state: "DONE", result: RESULT },
  });
  assert.equal(attempt.status, 403);
  assert.equal(attempt.json.error?.code, "E_TOKEN_SCOPE");
});
