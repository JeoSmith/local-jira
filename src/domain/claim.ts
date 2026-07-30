import { buildEvent } from "./events.ts";
import { timestamp, type Actor } from "./issue.ts";
import { claimability } from "./links.ts";
import { findRun, RunError, type RunRecord } from "./run.ts";
import { findIssue, type BoardHandle, type WritableBoard } from "../storage/board.ts";
import type { Claim, RuntimeStore } from "../storage/runtime.ts";

/**
 * Statuses an agent may claim from.
 *
 * `TODO` is the ordinary case. `IN_PROGRESS` is allowed only for the agent that
 * was already there, which is how a session that died mid-task resumes rather
 * than being locked out of its own work (§6.1, ADR-004 §2).
 */
const CLAIMABLE_FROM = new Set(["TODO", "IN_PROGRESS"]);

export class ClaimError extends Error {
  readonly code: string;
  readonly detail: string | null;
  readonly extra: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    detail: string | null = null,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ClaimError";
    this.code = code;
    this.detail = detail;
    this.extra = extra;
  }
}

export interface ClaimResult {
  claim: Claim;
  /** False when the claim was already held by this run and only renewed. */
  fresh: boolean;
  issueKey: string;
}

/**
 * Takes the claim on an issue for a run.
 *
 * Every refusal here is 409 with its own code (S3-D5): all three mean "not
 * now, but the conditions could change", which 403 would report as a
 * permission problem and 400 as a malformed request. Neither is true.
 */
export async function claimIssue(
  writable: WritableBoard,
  runtime: RuntimeStore,
  key: string,
  runId: string,
  actor: Actor,
  now: number = Date.now(),
): Promise<ClaimResult> {
  const board = writable.board;

  const found = findIssue(board, key);
  if (!found || !("issue" in found)) {
    throw new ClaimError("E_UNKNOWN_ISSUE", `No issue ${key}.`);
  }
  const issue = found.issue;
  const status = String((issue.resource as Record<string, unknown>).status ?? "");

  // ADR-004 §2 forbids owning anything through a placeholder run, so the run is
  // resolved before the claim exists rather than filled in afterwards.
  const run = requireRunnableRun(board, runId, actor);

  if (run.issueUid !== issue.uid) {
    throw new ClaimError(
      "E_RUN_OTHER_ISSUE",
      `${runId} was started for a different issue.`,
      "Start a run for this issue first.",
    );
  }

  if (!CLAIMABLE_FROM.has(status)) {
    // An unrefined backlog item is not work anybody agreed to do yet. A person
    // moves it to TODO first, and that move is the agreement (§6.1).
    throw new ClaimError(
      status === "BACKLOG" ? "E_CLAIM_NOT_REFINED" : "E_CLAIM_WRONG_STATUS",
      status === "BACKLOG"
        ? `${key} is still in the backlog.`
        : `${key} is ${status} and cannot be claimed.`,
      status === "BACKLOG" ? "A person moves it to TODO first." : null,
      { status },
    );
  }

  const blocking = claimability(board, issue.uid);
  if (!blocking.claimable) {
    throw new ClaimError(
      "E_CLAIM_BLOCKED",
      `${key} is waiting on ${blocking.blockedBy.join(", ")}.`,
      "Finish the blocking issues, or remove the blocked_by link.",
      { blocked_by: blocking.blockedBy },
    );
  }

  const taken = runtime.acquire(issue.uid, actor.id, runId, now);

  if (taken.outcome === "held") {
    throw new ClaimError(
      "E_CLAIM_HELD",
      `${key} is claimed by ${taken.by.ownerId}.`,
      "Wait for the lease to expire, or ask a person to release it.",
      {
        owner_id: taken.by.ownerId,
        run_id: taken.by.runId,
        lease_expires_at: new Date(taken.by.leaseExpiresAt).toISOString(),
      },
    );
  }

  // A resumed claim is the same claim, so recording a second acquisition would
  // put an event on the timeline for something that did not happen (D10).
  if (taken.outcome === "acquired") {
    if (status === "IN_PROGRESS") {
      // Reachable only when the previous claim's lease had expired: a live one
      // by somebody else would have been `held` above. Worth noting in the
      // record, because "picked up where a dead session left off" and "started
      // fresh" read the same otherwise.
      await record(writable, "claim.acquired", issue.uid, actor, run, {
        issue: key,
        resumed: true,
      });
    } else {
      await record(writable, "claim.acquired", issue.uid, actor, run, { issue: key });
    }
  }

  return {
    claim: taken.outcome === "held" ? taken.by : taken.claim,
    fresh: taken.outcome === "acquired",
    issueKey: key,
  };
}

/**
 * Whether this actor may make a claim-gated transition on this issue.
 *
 * The one place that answers it, so the HTTP gate and any future caller cannot
 * disagree about what "holding a claim" means.
 */
export function holdsClaimOn(
  runtime: RuntimeStore,
  issueUid: string,
  actorId: string,
  now: number = Date.now(),
): boolean {
  const claim = runtime.find(issueUid, now);
  return claim !== null && claim.ownerId === actorId;
}

function requireRunnableRun(board: BoardHandle, runId: string, actor: Actor): RunRecord {
  if (runId.trim() === "") {
    throw new ClaimError(
      "E_RUN_REQUIRED",
      "A claim needs the run that will do the work.",
      "Start one first: POST /runs",
    );
  }

  const run = findRun(board, runId);
  if (run === null) {
    throw new ClaimError("E_UNKNOWN_RUN", `No run ${runId}.`);
  }
  if (run.state !== "RUNNING") {
    throw new ClaimError(
      "E_RUN_NOT_RUNNING",
      `${runId} is ${run.state} and cannot hold a claim.`,
    );
  }
  if (run.agentId !== null && run.agentId !== actor.id) {
    throw new RunError("E_RUN_NOT_OWNED", `${runId} belongs to ${run.agentId}.`);
  }
  return run;
}

async function record(
  writable: WritableBoard,
  verb: "claim.acquired" | "claim.released" | "claim.reclaimed",
  issueUid: string,
  actor: Actor,
  run: RunRecord | null,
  after: Record<string, unknown>,
): Promise<void> {
  const board = writable.board;
  const event = buildEvent(board.localDirectory, {
    verb,
    targetKind: "issue",
    targetUid: issueUid,
    actor: {
      ...actor,
      runId: run?.runId ?? null,
      initiatedBy: run?.initiatedBy ?? null,
    },
    after: after as never,
    at: timestamp(null),
  });

  // The claim itself is runtime state, but that it was taken is history — a
  // team looking back has to see who worked on what even after the runtime
  // store is long gone (ADR-004 §1).
  await writable.writer.write({
    kind: "event",
    targetPath: event.path,
    contents: null,
    event,
    actorId: actor.id,
    actorKind: actor.kind,
  });
}
