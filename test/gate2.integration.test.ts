import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "./fixtures/cli-token.ts";

import { startServer, type RunningServer } from "../src/server/http.ts";
import { openBoardForWriting } from "../src/storage/board.ts";
import type { CrashPoint } from "../src/storage/writer.ts";

/**
 * Gate 2 of Sprint 01:
 *
 *   "an authorised change lands exactly once in the file, the index and the
 *    event log; a stale ETag is 412 and an unauthorised request is 403; and
 *    killing the process at every WriteTxn stage still recovers on restart"
 *
 * r09, r10, r01b, r12b and r14a each pass alone. This runs them as one path,
 * because the gate is about the seams: the same write has to be counted once
 * by three different stores, and the failure modes have to stay distinguishable
 * from each other.
 */

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

const CRASH_POINTS: CrashPoint[] = [
  "after_outbox",
  "before_rename",
  "after_rename",
  "after_index",
  "after_event",
];

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout;
}

function cli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  // r13c: `issue create` needs a token, which runCli mints for this board.
  return runCli(cwd, args, env);
}

interface Client {
  cookie: string;
}

async function call(
  server: RunningServer,
  client: Client,
  method: string,
  route: string,
  options: { body?: unknown; ifMatch?: string } = {},
) {
  const response = await fetch(`${server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(client.cookie ? { cookie: client.cookie } : {}),
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

async function signIn(server: RunningServer, id: string): Promise<Client> {
  const response = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, password: PASSWORD }),
  });
  assert.equal(response.status, 200, `${id} could not sign in`);
  return { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] };
}

function eventsOf(board: string): Array<Record<string, unknown>> {
  const root = path.join(board, "events");
  if (!fs.existsSync(root)) {
    return [];
  }
  const records: Array<Record<string, unknown>> = [];
  for (const day of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, day))) {
      for (const line of fs.readFileSync(path.join(root, day, file), "utf8").split("\n")) {
        if (line.trim() !== "") {
          records.push(JSON.parse(line) as Record<string, unknown>);
        }
      }
    }
  }
  return records;
}

test("Gate 2: one change, three stores, and every failure kept distinct", { timeout: 180_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-gate2-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "gate2@example.com"]);
  git(repo, ["config", "user.name", "Gate Two"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  const board = path.join(repo, ".localjira");
  cli(repo, ["init", "--project-key", "LJ", "--project-name", "Local Jira", "--timezone", "Asia/Seoul"]);
  cli(repo, ["admin", "create", "--id", "admin", "--name", "관리자", "--password", PASSWORD]);
  cli(repo, ["admin", "create", "--id", "dev", "--name", "개발자", "--password", PASSWORD, "--role", "member"]);
  cli(repo, ["admin", "create", "--id", "bot", "--name", "에이전트", "--password", PASSWORD, "--role", "agent"]);

  // ── 1. an authorised change lands exactly once in each store ──────────────
  let issueKey = "";
  let liveEtag = "";

  const server = await startServer({ cwd: repo, port: 0, watch: false });
  try {
    const admin = await signIn(server, "admin");
    const member = await signIn(server, "dev");
    const agent = await signIn(server, "bot");

    const created = await call(server, member, "POST", "/issues", {
      body: { project: "LJ", type: "story", title: "게이트 2", points: 3 },
    });
    assert.equal(created.status, 201);
    issueKey = created.json.key as unknown as string;

    const updated = await call(server, member, "PUT", `/issues/${issueKey}`, {
      ifMatch: created.etag ?? "",
      body: { points: 8 },
    });
    assert.equal(updated.status, 200);
    liveEtag = updated.etag ?? "";

    // One update: one file, one index row, one event.
    const file = fs.readFileSync(path.join(board, "issues", "LJ", `${issueKey}.md`), "utf8");
    assert.match(file, /^points: 8$/m);

    const shown = await call(server, member, "GET", `/issues/${issueKey}`);
    assert.equal((shown.json as unknown as Record<string, unknown>).points, 8);
    assert.equal(shown.etag, liveEtag, "the index agrees with the file");

    const updates = eventsOf(board).filter((event) => event.verb === "issue.updated");
    assert.equal(updates.length, 1, "the event log counted the change once");
    assert.deepEqual(updates[0].before, { points: 3 });
    assert.deepEqual(updates[0].after, { points: 8 });

    // ── 2. the three refusals stay distinct ────────────────────────────────
    const stale = await call(server, member, "PUT", `/issues/${issueKey}`, {
      ifMatch: created.etag ?? "",
      body: { points: 13 },
    });
    assert.equal(stale.status, 412, "a stale ETag is a conflict");

    const missing = await call(server, member, "PUT", `/issues/${issueKey}`, {
      body: { points: 13 },
    });
    assert.equal(missing.status, 428, "a missing precondition is not a conflict");

    const forbidden = await call(server, agent, "PUT", `/issues/${issueKey}`, {
      ifMatch: liveEtag,
      body: { points: 13 },
    });
    assert.equal(forbidden.status, 403, "a known caller without the capability is forbidden");

    const anonymous = await call(server, { cookie: "" }, "PUT", `/issues/${issueKey}`, {
      ifMatch: liveEtag,
      body: { points: 13 },
    });
    assert.equal(anonymous.status, 401, "an unknown caller is unauthenticated");

    const operational = await call(server, member, "POST", "/users", {
      body: { id: "sneaky", display_name: "x", role: "admin", password: PASSWORD },
    });
    assert.equal(operational.status, 403);

    // None of the four refusals may have changed anything.
    const after = await call(server, admin, "GET", `/issues/${issueKey}`);
    assert.equal(after.etag, liveEtag);
    assert.equal((after.json as unknown as Record<string, unknown>).points, 8);
    assert.equal(
      eventsOf(board).filter((event) => event.verb === "issue.updated").length,
      1,
      "a refused write must not appear in the audit trail as a change",
    );
    // The refused *attempt* on an operational capability is recorded, though.
    assert.equal(eventsOf(board).filter((event) => event.verb === "access.denied").length, 1);
  } finally {
    await server.close();
  }

  // ── 3. a crash at every stage still recovers ──────────────────────────────
  const beforeCrashes = {
    issues: fs.readdirSync(path.join(board, "issues", "LJ")).sort(),
    events: eventsOf(board).length,
  };

  for (const point of CRASH_POINTS) {
    const crashed = cli(
      repo,
      ["issue", "create", "--project", "LJ", "--type", "task", "--title", `crash ${point}`],
      { LOCALJIRA_WRITE_CRASH_AT: point },
    );
    assert.ok(
      crashed.signal === "SIGABRT" || crashed.status !== 0,
      `${point} did not abort: ${crashed.status}/${crashed.signal}`,
    );

    // Restart: the replay finishes or abandons the write, and either way the
    // board comes back readable with no duplicates.
    const recovered = await openBoardForWriting(repo);
    try {
      assert.ok(recovered.writer.replayComplete, `${point} left the writer unusable`);

      for (const name of fs.readdirSync(path.join(board, "issues", "LJ"))) {
        assert.equal(name.endsWith(".tmp"), false, `${point} left a temp file`);
      }

      const ids = eventsOf(board).map((event) => event.event_id as string);
      assert.equal(new Set(ids).size, ids.length, `${point} duplicated an event`);

      const rows = recovered.board.db
        .prepare("SELECT key, COUNT(*) c FROM issues GROUP BY key HAVING c > 1")
        .all();
      assert.deepEqual(rows, [], `${point} duplicated an index row`);
    } finally {
      await recovered.close();
    }
  }

  // The original issue is untouched by any of it.
  const survivor = await openBoardForWriting(repo);
  try {
    const row = survivor.board.db
      .prepare("SELECT points, etag FROM issues WHERE key = ?")
      .get(issueKey) as { points: number; etag: string };
    assert.equal(row.points, 8);
    assert.equal(`"${row.etag}"`, liveEtag, "the ETag survived five crashes unchanged");
  } finally {
    await survivor.close();
  }

  assert.ok(
    fs.readdirSync(path.join(board, "issues", "LJ")).length >= beforeCrashes.issues.length,
    "recovery must not delete issues that already existed",
  );
});
