import fs from "node:fs";
import path from "node:path";

import { createUlid } from "../bootstrap/identifier.ts";
import { buildEvent } from "./events.ts";
import { IssueError, timestamp, type Actor } from "./issue.ts";
import { canonicalJson, type JsonValue } from "../storage/jcs.ts";
import { findIssue, type BoardHandle, type WritableBoard } from "../storage/board.ts";

/**
 * What a run's `state` may be (S3-D2).
 *
 * `STALE` is not here on purpose. ADR-004 §3 computes it from the clock and
 * `last_heartbeat_at`, and storing it would need something to sweep every run
 * every three minutes — a job whose failure would silently make every dead run
 * look alive. Computing it means there is nothing to fail.
 *
 * `DONE` and `FAILED` are separate because r17b has to show a run that ended
 * without submitting its result differently from one that finished.
 */
export const RUN_STATES = ["RUNNING", "DONE", "FAILED", "CANCELLED"] as const;
export type RunState = (typeof RUN_STATES)[number];

/** ADR-004 §3: expected every 60 seconds. */
export const HEARTBEAT_PERIOD_MS = 60_000;
/** Three missed beats. A warning; the lease still holds (ADR-004 §3). */
export const STALE_AFTER_MS = 3 * HEARTBEAT_PERIOD_MS;

export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value);
}

export interface StartRunInput {
  /** Display key of the issue this run is for. */
  issue: string;
  sessionId: string;
  agentId: string;
  /** The person who directed the agent (§6.2). */
  initiatedBy: string;
  branch: string;
  idempotency?: { actorId: string; key: string };
}

export interface RunRecord {
  runId: string;
  issueUid: string;
  issueKey: string | null;
  sessionId: string | null;
  agentId: string | null;
  initiatedBy: string | null;
  branch: string | null;
  state: RunState;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  endedAt: string | null;
  result: JsonValue | null;
  /** Computed, never stored (S3-D2). */
  stale: boolean;
}

export class RunError extends Error {
  readonly code: string;
  readonly detail: string | null;

  constructor(code: string, message: string, detail: string | null = null) {
    super(message);
    this.name = "RunError";
    this.code = code;
    this.detail = detail;
  }
}

function runPath(project: string, startedAt: string, runId: string): string {
  // Month directories, so a long-lived board does not end up with one
  // directory holding every run it ever made (§5.3).
  return `runs/${project}/${startedAt.slice(0, 7)}/${runId}.json`;
}

/**
 * Registers a run against an issue.
 *
 * A run is file SoT, unlike the claim it will go on to hold: the claim is
 * local runtime state that means nothing in another clone, while "this session
 * did this work on this branch" is history the team keeps (ADR-004 §1).
 */
export async function startRun(
  writable: WritableBoard,
  input: StartRunInput,
  actor: Actor,
): Promise<RunRecord> {
  const board = writable.board;

  // All four are required by §6.2, and a missing one is refused rather than
  // defaulted: a run whose `initiated_by` we guessed is a run that cannot
  // answer "who told the agent to do this".
  for (const [field, value] of [
    ["issue", input.issue],
    ["session_id", input.sessionId],
    ["agent_id", input.agentId],
    ["initiated_by", input.initiatedBy],
    ["branch", input.branch],
  ] as const) {
    if (value.trim() === "") {
      throw new RunError("E_RUN_FIELD_MISSING", `${field} is required to start a run.`);
    }
  }

  const found = findIssue(board, input.issue);
  if (!found || !("issue" in found)) {
    throw new RunError("E_UNKNOWN_ISSUE", `No issue ${input.issue} to run against.`);
  }
  const issue = found.issue;
  const project = projectOf(issue.key);

  const runId = createUlid();
  const now = timestamp(projectTimezone(board, project));
  const relative = runPath(project, now, runId);

  const record: Record<string, JsonValue> = {
    schema_version: 1,
    run_id: runId,
    issue_uid: issue.uid,
    session_id: input.sessionId,
    agent_id: input.agentId,
    initiated_by: input.initiatedBy,
    branch: input.branch,
    state: "RUNNING",
    started_at: now,
    last_heartbeat_at: now,
    ended_at: null,
  };

  await writable.writer.write({
    kind: "create",
    targetPath: relative,
    contents: `${canonicalJson(record)}\n`,
    expectedHash: null,
    event: buildEvent(board.localDirectory, {
      verb: "run.started",
      targetKind: "run",
      targetUid: runId,
      actor: { ...actor, runId, initiatedBy: input.initiatedBy },
      after: {
        run_id: runId,
        issue: issue.key,
        agent_id: input.agentId,
        initiated_by: input.initiatedBy,
        branch: input.branch,
        session_id: input.sessionId,
      },
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
    idempotency: input.idempotency,
  });

  const stored = findRun(board, runId);
  if (stored === null) {
    throw new RunError("E_RUN_NOT_READABLE", `${runId} was written but could not be read back.`);
  }
  return stored;
}

/**
 * Records that a run is still alive, and pushes its claim's lease out.
 *
 * One endpoint for both (S3-D3). Splitting them would let an agent report on
 * one and not the other, leaving a run that looks alive holding an expired
 * claim, or the reverse. The process reporting is one thing, so the signal is
 * one thing.
 */
export async function heartbeatRun(
  writable: WritableBoard,
  runId: string,
  actor: Actor,
  renewLease: (run: RunRecord) => void,
): Promise<RunRecord> {
  const board = writable.board;
  const run = requireRun(board, runId);

  if (run.state !== "RUNNING") {
    // A finished run cannot come back. Accepting the beat would revive a
    // session that already reported its outcome (r17a AC10).
    throw new RunError(
      "E_RUN_NOT_RUNNING",
      `${runId} is ${run.state} and no longer reports.`,
      "Start a new run.",
    );
  }
  requireOwner(run, actor);

  const now = timestamp(projectTimezone(board, projectOfRun(board, run)));
  await rewriteRun(writable, run, { last_heartbeat_at: now }, actor, null);
  const updated = requireRun(board, runId);
  renewLease(updated);
  return updated;
}

export interface EndRunInput {
  state: Extract<RunState, "DONE" | "FAILED" | "CANCELLED">;
  result?: JsonValue | null;
}

export async function endRun(
  writable: WritableBoard,
  runId: string,
  input: EndRunInput,
  actor: Actor,
): Promise<RunRecord> {
  const board = writable.board;
  const run = requireRun(board, runId);

  if (run.state !== "RUNNING") {
    throw new RunError("E_RUN_NOT_RUNNING", `${runId} is already ${run.state}.`);
  }
  requireOwner(run, actor);

  const now = timestamp(projectTimezone(board, projectOfRun(board, run)));
  await rewriteRun(
    writable,
    run,
    {
      state: input.state,
      ended_at: now,
      ...(input.result === undefined || input.result === null ? {} : { result: input.result }),
    },
    actor,
    {
      verb: "run.ended",
      after: { run_id: runId, state: input.state },
    },
  );
  return requireRun(board, runId);
}

/**
 * Rewrites a run file with fields merged in.
 *
 * Read-modify-write of the whole document rather than a patch, because the file
 * is the source of truth and a partial write would leave a document the parser
 * would have to guess at. The writer serialises per path, so two heartbeats
 * cannot interleave.
 */
async function rewriteRun(
  writable: WritableBoard,
  run: RunRecord,
  changes: Record<string, JsonValue>,
  actor: Actor,
  event: { verb: "run.ended"; after: Record<string, JsonValue> } | null,
): Promise<void> {
  const board = writable.board;
  const relative = pathOfRun(board, run.runId);
  const current = JSON.parse(
    readRunFile(board, relative),
  ) as Record<string, JsonValue>;

  const merged: Record<string, JsonValue> = { ...current, ...changes };
  await writable.writer.write({
    kind: "update",
    targetPath: relative,
    contents: `${canonicalJson(merged)}\n`,
    expectedHash: undefined,
    ...(event === null
      ? {}
      : {
          event: buildEvent(board.localDirectory, {
            verb: event.verb,
            targetKind: "run",
            targetUid: run.runId,
            actor: { ...actor, runId: run.runId, initiatedBy: run.initiatedBy },
            after: event.after,
          }),
        }),
    actorId: actor.id,
    actorKind: actor.kind,
  });
}

function readRunFile(board: BoardHandle, relative: string): string {
  return fs.readFileSync(path.join(board.boardRoot, relative), "utf8");
}

/**
 * The run, with `STALE` worked out at read time.
 *
 * A caller never sees a stored `STALE`, because there is none — the value is a
 * function of now, and computing it here means every reader agrees without
 * anything having to keep them in step (ADR-004 §3).
 */
export function findRun(
  board: BoardHandle,
  runId: string,
  now: number = Date.now(),
): RunRecord | null {
  const row = board.db
    .prepare(
      `SELECT r.run_id, r.issue_uid, r.session_id, r.agent_id, r.initiated_by, r.branch,
              r.state, r.started_at, r.last_heartbeat_at, r.ended_at, r.result_json,
              i.key AS issue_key
         FROM runs r LEFT JOIN issues i ON i.uid = r.issue_uid AND i.state = 'OK'
        WHERE r.run_id = ?`,
    )
    .get(runId) as Record<string, unknown> | undefined;
  return row ? toRun(row, now) : null;
}

export function listRunsFor(
  board: BoardHandle,
  issueUid: string,
  now: number = Date.now(),
): RunRecord[] {
  return (
    board.db
      .prepare(
        `SELECT r.run_id, r.issue_uid, r.session_id, r.agent_id, r.initiated_by, r.branch,
                r.state, r.started_at, r.last_heartbeat_at, r.ended_at, r.result_json,
                i.key AS issue_key
           FROM runs r LEFT JOIN issues i ON i.uid = r.issue_uid AND i.state = 'OK'
          WHERE r.issue_uid = ? ORDER BY r.started_at DESC, r.run_id DESC`,
      )
      .all(issueUid) as Array<Record<string, unknown>>
  ).map((row) => toRun(row, now));
}

function toRun(row: Record<string, unknown>, now: number): RunRecord {
  const state = String(row.state ?? "RUNNING");
  const lastBeat = row.last_heartbeat_at === null ? null : String(row.last_heartbeat_at);
  const since = lastBeat === null ? null : Date.parse(lastBeat);

  return {
    runId: String(row.run_id),
    issueUid: String(row.issue_uid ?? ""),
    issueKey: row.issue_key === null || row.issue_key === undefined ? null : String(row.issue_key),
    sessionId: row.session_id === null ? null : String(row.session_id),
    agentId: row.agent_id === null ? null : String(row.agent_id),
    initiatedBy: row.initiated_by === null ? null : String(row.initiated_by),
    branch: row.branch === null ? null : String(row.branch),
    state: isRunState(state) ? state : "RUNNING",
    startedAt: row.started_at === null ? null : String(row.started_at),
    lastHeartbeatAt: lastBeat,
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    result:
      row.result_json === null || row.result_json === undefined
        ? null
        : (JSON.parse(String(row.result_json)) as JsonValue),
    // Only a running run can be stale. One that ended is finished, however long
    // ago its last beat was.
    stale:
      state === "RUNNING" &&
      since !== null &&
      Number.isFinite(since) &&
      now - since > STALE_AFTER_MS,
  };
}

function requireRun(board: BoardHandle, runId: string): RunRecord {
  const run = findRun(board, runId);
  if (run === null) {
    throw new RunError("E_UNKNOWN_RUN", `No run ${runId}.`);
  }
  return run;
}

/**
 * Refuses a run's own reports from anybody but the agent that started it.
 *
 * Without this an agent holding `run:write` could end another agent's run, and
 * with it release the claim that run holds.
 */
function requireOwner(run: RunRecord, actor: Actor): void {
  if (run.agentId !== null && run.agentId !== actor.id) {
    throw new RunError(
      "E_RUN_NOT_OWNED",
      `${run.runId} belongs to ${run.agentId}.`,
      "Only the agent that started a run may report on it.",
    );
  }
}

function pathOfRun(board: BoardHandle, runId: string): string {
  const row = board.db
    .prepare("SELECT path FROM runs WHERE run_id = ?")
    .get(runId) as { path?: string } | undefined;
  if (!row?.path) {
    throw new RunError("E_UNKNOWN_RUN", `No run ${runId}.`);
  }
  return row.path;
}

function projectOfRun(board: BoardHandle, run: RunRecord): string {
  return run.issueKey === null ? defaultProject(board) : projectOf(run.issueKey);
}

function projectOf(key: string): string {
  return /^([^-]+)-/.exec(key)?.[1] ?? key;
}

function defaultProject(board: BoardHandle): string {
  const row = board.db
    .prepare("SELECT v FROM board_config WHERE k = 'default_project'")
    .get() as { v?: string } | undefined;
  return row?.v ?? "LJ";
}

function projectTimezone(board: BoardHandle, project: string): string {
  const row = board.db
    .prepare("SELECT timezone FROM projects WHERE key = ?")
    .get(project) as { timezone?: string } | undefined;
  if (!row?.timezone) {
    throw new IssueError("E_UNKNOWN_PROJECT", `No project ${project}.`);
  }
  return row.timezone;
}
