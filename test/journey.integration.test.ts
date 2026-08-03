import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer, type RunningServer } from "../src/server/http.ts";

/**
 * One run of the product, start to finish, in the order the PRD tells it.
 *
 * §4's three scenarios — an agent loading the backlog (S1), a person planning
 * (S2), an agent working (S3) — are each covered by their own suites. This is
 * the only test that walks them as one path on one board, which is where the
 * seams show: every story can pass alone while the joins between them do not.
 * Two of this session's defects were exactly that shape, found by walking the
 * product by hand rather than by any unit test.
 *
 * It asserts on the **files** wherever it can. A 200 says the server accepted a
 * request; the file is what the board still holds after the index is thrown
 * away (ADR-001), and where the two could disagree the file is the answer.
 *
 * Steps are subtests so a failure names the step, but they share one board on
 * purpose — the sequence is the thing under test.
 */

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const HUMAN_PASSWORD = "correct horse battery";
const AGENT_PASSWORD = "agent horse battery";

interface Journey {
  repo: string;
  board: string;
  server: RunningServer;
  cookie: string;
  token: string;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout;
}

function cli(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `localjira ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

interface Reply {
  status: number;
  json: Record<string, never>;
  etag: string | null;
  text: string;
}

async function call(
  journey: Journey,
  method: string,
  route: string,
  options: { body?: unknown; etag?: string | null; as?: "human" | "agent"; key?: string } = {},
): Promise<Reply> {
  const as = options.as ?? "human";
  const response = await fetch(`${journey.server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(as === "human"
        ? { cookie: journey.cookie }
        : { authorization: `Bearer ${journey.token}` }),
      ...(options.etag ? { "if-match": options.etag } : {}),
      ...(options.key ? { "idempotency-key": options.key } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let json = {} as Record<string, never>;
  try {
    json = text ? (JSON.parse(text) as Record<string, never>) : json;
  } catch {
    // CSV export, and anything else that is not JSON.
  }
  return { status: response.status, json, etag: response.headers.get("etag"), text };
}

/** The ETag the next write has to send, read fresh (D15). */
async function etagOf(journey: Journey, key: string): Promise<string> {
  const current = await call(journey, "GET", `/issues/${key}`);
  assert.equal(current.status, 200);
  return current.etag ?? "";
}

function issueFile(journey: Journey, key: string): string {
  return fs.readFileSync(path.join(journey.board, "issues", "LJ", `${key}.md`), "utf8");
}

function field(text: string, name: string): string | null {
  const found = new RegExp(`^${name}: (.+)$`, "m").exec(text);
  return found === null ? null : found[1].trim().replace(/^"(.*)"$/, "$1");
}

function events(journey: Journey): Array<Record<string, string>> {
  const directory = path.join(journey.board, "events");
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .flatMap((entry) =>
      fs
        .readFileSync(path.join(entry.parentPath, entry.name), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, string>),
    );
}

/**
 * A board as somebody would actually have one: a code repository, `init`, an
 * account, and a token — not a fixture assembled behind the product's back.
 */
async function begin(t: { after: (fn: () => void) => void }): Promise<Journey> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-journey-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "j@example.com"]);
  git(repo, ["config", "user.name", "Journey"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  cli(repo, ["init", "--project-key", "LJ", "--project-name", "여정", "--timezone", "Asia/Seoul"]);
  cli(repo, ["admin", "create", "--id", "kim", "--name", "사람", "--password", HUMAN_PASSWORD]);
  cli(repo, [
    "admin", "create", "--id", "bot", "--name", "에이전트",
    "--password", AGENT_PASSWORD, "--role", "agent",
  ]);
  const issued = cli(repo, [
    "token", "create", "--user", "bot", "--password", AGENT_PASSWORD,
    "--scope", "issue:read", "--scope", "issue:edit",
    "--scope", "issue:transition", "--scope", "issue:comment", "--scope", "run:write",
  ]);

  const server = await startServer({ cwd: repo, port: 0, watch: false });
  t.after(() => server.close());

  const login = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "kim", password: HUMAN_PASSWORD }),
  });
  assert.equal(login.status, 200);

  return {
    repo,
    board: path.join(repo, ".localjira"),
    server,
    cookie: (login.headers.get("set-cookie") ?? "").split(";")[0],
    token: issued.stdout.trim(),
  };
}

test("one board, start to finish", { timeout: 300_000 }, async (t) => {
  const journey = await begin(t);
  const made: string[] = [];
  let sprint = "";
  let runId = "";
  let commentId = "";

  await t.test("M0: init leaves the board on its own orphan branch (D1)", () => {
    const worktrees = git(journey.repo, ["worktree", "list", "--porcelain"]);
    assert.match(worktrees, /^branch refs\/heads\/localjira\/data$/m);
    assert.ok(fs.existsSync(path.join(journey.board, "config.yaml")));
    // The code side ignores it, so a board never lands in a code commit.
    assert.match(
      fs.readFileSync(path.join(journey.repo, ".gitignore"), "utf8"),
      /\.localjira\//,
    );
  });

  await t.test("S1: an agent loads the backlog, and the file says so (D16)", async () => {
    for (const title of ["로그인 화면", "비밀번호 재설정", "세션 만료 처리"]) {
      const created = await call(journey, "POST", "/issues", {
        as: "agent",
        body: { project: "LJ", type: "story", title },
        // A key derived from the payload, not the clock — the same submission
        // twice is one issue (r15). Hex because a header is latin-1 only.
        key: `journey-${Buffer.from(title).toString("hex").slice(0, 24)}`,
      });
      assert.equal(created.status, 201, created.text);
      made.push(created.json.key as unknown as string);
    }
    assert.equal(made.length, 3);

    const file = issueFile(journey, made[0]);
    assert.equal(field(file, "created_by_kind"), "agent", "an agent's work is filed as an agent's");
    assert.equal(field(file, "status"), "BACKLOG", "creation is always BACKLOG (S1-D1)");

    const again = await call(journey, "POST", "/issues", {
      as: "agent",
      body: { project: "LJ", type: "story", title: "로그인 화면" },
      key: `journey-${Buffer.from("로그인 화면").toString("hex").slice(0, 24)}`,
    });
    assert.equal(again.json.key as unknown as string, made[0], "the same key is the same issue");

    const created = events(journey).filter((event) => event.verb === "issue.created");
    assert.ok(created.length >= 3);
    assert.ok(created.slice(-3).every((event) => event.actor_kind === "agent"));
  });

  await t.test("the agent cannot start what it just loaded (§6.1)", async () => {
    const run = await call(journey, "POST", "/runs", {
      as: "agent",
      body: {
        issue: made[0], session_id: "s1", agent_id: "bot",
        initiated_by: "kim", branch: "feat/login",
      },
    });
    assert.equal(run.status, 201, run.text);
    runId = run.json.run_id as unknown as string;

    const refused = await call(journey, "POST", `/issues/${made[0]}/claim`, {
      as: "agent", body: { run_id: runId },
    });
    // This gate is what let AI refine be dropped (D16): a person has to raise
    // the issue to TODO before anything starts on it.
    assert.equal(refused.status, 409);
    assert.equal(
      (refused.json as unknown as { error: { code: string } }).error.code,
      "E_CLAIM_NOT_REFINED",
    );
  });

  await t.test("S2: a person plans the sprint", async () => {
    const created = await call(journey, "POST", "/projects/LJ/sprints", {
      body: { name: "스프린트 1", capacity: 20 },
    });
    assert.ok(created.status === 200 || created.status === 201, created.text);
    sprint = created.json.id as unknown as string;

    for (const key of made) {
      const moved = await call(journey, "PATCH", `/issues/${key}`, {
        body: { sprint }, etag: await etagOf(journey, key),
      });
      assert.equal(moved.status, 200, moved.text);
    }
    assert.ok(made.every((key) => field(issueFile(journey, key), "sprint") === sprint));

    const raised = await call(journey, "POST", `/issues/${made[0]}/transitions`, {
      body: { to: "TODO" }, etag: await etagOf(journey, made[0]),
    });
    assert.equal(raised.status, 200, raised.text);
    assert.equal(field(issueFile(journey, made[0]), "status"), "TODO");

    assert.equal((await call(journey, "POST", `/sprints/${sprint}/start`)).status, 200);
  });

  await t.test("S3: the agent claims, works and hands back", async () => {
    const claimed = await call(journey, "POST", `/issues/${made[0]}/claim`, {
      as: "agent", body: { run_id: runId },
    });
    assert.equal(claimed.status, 200, claimed.text);

    // The read path r01e needed: who holds this, without going via the board.
    const held = await call(journey, "GET", `/issues/${made[0]}/claim`);
    assert.equal(
      (held.json as unknown as { claim: { owner_id: string } }).claim.owner_id,
      "bot",
    );

    const moved = await call(journey, "POST", `/issues/${made[0]}/transitions`, {
      as: "agent", body: { to: "IN_PROGRESS" }, etag: await etagOf(journey, made[0]),
    });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(field(issueFile(journey, made[0]), "status"), "IN_PROGRESS");

    // The same move on an issue it does not hold. §6.1 couples the claim to the
    // transition, so a token with `issue:transition` is still refused.
    await call(journey, "POST", `/issues/${made[1]}/transitions`, {
      body: { to: "TODO" }, etag: await etagOf(journey, made[1]),
    });
    const unclaimed = await call(journey, "POST", `/issues/${made[1]}/transitions`, {
      as: "agent", body: { to: "IN_PROGRESS" }, etag: await etagOf(journey, made[1]),
    });
    assert.equal(unclaimed.status, 403, unclaimed.text);
  });

  await t.test("a question stops the work until somebody answers it (§6.3)", async () => {
    const asked = await call(journey, "POST", `/issues/${made[0]}/comments`, {
      body: { body: "이 화면이 정말 필요한가요?", kind: "question" },
    });
    assert.equal(asked.status, 201, asked.text);
    commentId = (asked.json.comment_id ?? asked.json.id) as unknown as string;

    const blocked = await call(journey, "GET", `/issues/${made[0]}/context`, { as: "agent" });
    const reasons = (blocked.json as unknown as { blocked_reason: unknown[] }).blocked_reason ?? [];
    assert.ok(reasons.length > 0, "an unanswered question blocks the issue");

    const resolved = await call(journey, "POST", `/comments/${commentId}/ops`, {
      body: { op: "resolve" },
    });
    assert.ok(resolved.status === 200 || resolved.status === 201, resolved.text);

    const free = await call(journey, "GET", `/issues/${made[0]}/context`, { as: "agent" });
    assert.deepEqual(
      (free.json as unknown as { blocked_reason: unknown[] }).blocked_reason ?? [],
      [],
    );
  });

  await t.test("two writers on one ETag: the second is refused (D15)", async () => {
    const shared = await etagOf(journey, made[2]);
    const first = await call(journey, "PATCH", `/issues/${made[2]}`, {
      body: { title: "첫 번째 수정" }, etag: shared,
    });
    const second = await call(journey, "PATCH", `/issues/${made[2]}`, {
      body: { title: "두 번째 수정" }, etag: shared,
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 412);
    // A 412 that only says "no" makes the client guess. It carries the current
    // document and ETag so the screen can show what actually differs.
    assert.ok("etag" in second.json && "document" in second.json, Object.keys(second.json).join());
    assert.equal(field(issueFile(journey, made[2]), "title"), "첫 번째 수정");

    const headerless = await call(journey, "PATCH", `/issues/${made[2]}`, {
      body: { title: "헤더 없이" },
    });
    assert.equal(headerless.status, 428, "a missing If-Match is the client's bug, not a merge");
  });

  await t.test("the screen is told what may be chosen, not left to work it out (r02c)", async () => {
    const epic = await call(journey, "POST", "/issues", {
      body: { project: "LJ", type: "epic", title: "인증" },
    });
    assert.equal(epic.status, 201, epic.text);

    const forStory = await call(journey, "GET", `/issues/${made[2]}/assignable`);
    const parents = (forStory.json as unknown as { parents: Array<{ type: string }> }).parents;
    assert.ok(parents.length > 0);
    assert.ok(parents.every((entry) => entry.type === "epic"));

    const forEpic = await call(journey, "GET", `/issues/${epic.json.key}/assignable`);
    assert.equal(
      (forEpic.json as unknown as { parent_allowed: boolean }).parent_allowed,
      false,
      "an epic is told it can never have one, which is not the same as having none",
    );

    const linked = await call(journey, "PATCH", `/issues/${made[2]}`, {
      body: { parent: epic.json.uid }, etag: await etagOf(journey, made[2]),
    });
    assert.equal(linked.status, 200, linked.text);
    assert.equal(field(issueFile(journey, made[2]), "parent"), epic.json.uid as unknown as string);
  });

  await t.test("deleting a parent makes the caller choose, and leaves the board valid", async () => {
    const epicKey = (await call(journey, "GET", "/issues?limit=100")).json as unknown as {
      issues: Array<{ key: string; type: string }>;
    };
    const epic = epicKey.issues.find((issue) => issue.type === "epic")!.key;

    const refused = await call(journey, "DELETE", `/issues/${epic}`, {
      etag: await etagOf(journey, epic),
    });
    assert.equal(refused.status, 409);
    // The children and the strategy names come from here, which is why the
    // screen does not carry a copy of §5.1 (r01e).
    assert.ok((refused.json as unknown as { children: unknown[] }).children.length > 0);
    assert.deepEqual(
      (refused.json as unknown as { strategies: string[] }).strategies,
      ["promote", "cascade_cancel"],
    );

    const deleted = await call(journey, "DELETE", `/issues/${epic}?strategy=promote`, {
      etag: await etagOf(journey, epic),
    });
    assert.equal(deleted.status, 204);
    assert.equal(fs.existsSync(path.join(journey.board, "issues", "LJ", `${epic}.md`)), false);
    assert.equal(field(issueFile(journey, made[2]), "parent"), null, "the child is top level now");

    const integrity = await call(journey, "GET", "/integrity/issues");
    assert.deepEqual(
      (integrity.json as unknown as { quarantined: unknown[] }).quarantined,
      [],
      "a documented deletion must not leave an INVALID issue behind",
    );
  });

  await t.test("appending to the backlog does not exhaust the rank (LJ-48)", async () => {
    const ranks: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const created = await call(journey, "POST", "/issues", {
        body: { project: "LJ", type: "task", title: `덧붙임 ${index}` },
      });
      assert.equal(created.status, 201, created.text);
      ranks.push(field(issueFile(journey, created.json.key as unknown as string), "backlog_rank")!);
    }

    assert.equal(new Set(ranks).size, ranks.length, "every append is a distinct rank");
    // The old behaviour reached the 32-char limit at the fourteenth append and
    // reused the previous rank from then on.
    assert.ok(Math.max(...ranks.map((rank) => rank.length)) <= 8, ranks[ranks.length - 1]);

    const integrity = await call(journey, "GET", "/integrity/issues");
    assert.equal(
      (integrity.json as unknown as { duplicateRankRegions: number }).duplicateRankRegions,
      0,
    );
  });

  await t.test("a person closes the work, and the card still says where it came from", async () => {
    const review = await call(journey, "POST", `/issues/${made[0]}/transitions`, {
      as: "agent", body: { to: "IN_REVIEW" }, etag: await etagOf(journey, made[0]),
    });
    assert.equal(review.status, 200, review.text);
    const done = await call(journey, "POST", `/issues/${made[0]}/transitions`, {
      body: { to: "DONE" }, etag: await etagOf(journey, made[0]),
    });
    assert.equal(done.status, 200, done.text);
    assert.equal(field(issueFile(journey, made[0]), "status"), "DONE");

    // S6-D5. The actor badge now reads 사람, because a person made the last
    // change — which is exactly the moment the origin has to survive.
    const board = await call(journey, "GET", "/projects/LJ/board");
    const card = (board.json as unknown as {
      issues: Array<{ key: string; created_by_kind: string; last_actor_kind: string }>;
    }).issues.find((issue) => issue.key === made[0])!;
    assert.equal(card.last_actor_kind, "human");
    assert.equal(card.created_by_kind, "agent");

    assert.equal((await call(journey, "GET", `/sprints/${sprint}/burndown`)).status, 200);
  });

  await t.test("the board can be taken out again", async () => {
    const csv = await call(journey, "GET", "/export.csv");
    assert.equal(csv.status, 200);
    assert.ok(csv.text.includes(","), "a CSV with no separator is not a CSV");

    const json = await call(journey, "GET", "/export.json");
    assert.equal(json.status, 200);
    const dumped = JSON.parse(json.text.replace(/^﻿/, "")) as unknown[];
    assert.ok(Array.isArray(dumped) && dumped.length > 0);
  });

  await t.test("throwing the index away changes nothing (ADR-001)", async () => {
    const before = Object.fromEntries(
      made.map((key) => [key, field(issueFile(journey, key), "status")]),
    );

    assert.equal((await call(journey, "POST", "/index/rebuild")).status, 200);

    const listed = await call(journey, "GET", "/issues?limit=200");
    const after = new Map(
      (listed.json as unknown as { issues: Array<{ key: string; status: string }> }).issues
        .map((issue) => [issue.key, issue.status]),
    );
    for (const [key, status] of Object.entries(before)) {
      assert.equal(after.get(key), status, `${key} came back as something else`);
    }
  });

  await t.test("the service never commits (D4·R25)", () => {
    const dirty = git(journey.board, ["status", "--porcelain"])
      .split("\n")
      .filter((line) => line.trim() !== "");
    assert.ok(dirty.length > 0, "a session's work is left for the person to commit");

    // One commit: the one `init` made. Everything since is uncommitted, which is
    // what the badge counts and what makes `git checkout` an undo.
    const log = git(journey.board, ["log", "--oneline"]).split("\n").filter(Boolean);
    assert.equal(log.length, 1, log.join(" / "));
  });
});
