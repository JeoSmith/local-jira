import fs from "node:fs";
import path from "node:path";

import type { BoardHandle, WritableBoard } from "../storage/board.ts";
import { fileHash, formatEtag } from "../storage/resource.ts";
import { yamlScalar } from "../bootstrap/scaffold.ts";
import { buildEvent } from "./events.ts";
import { IssueError, projectTimezone, timestamp, type Actor } from "./issue.ts";
import { PreconditionFailedError, PreconditionRequiredError } from "./update.ts";
import type { JsonValue } from "../storage/jcs.ts";

export const SPRINT_STATUSES = ["PLANNED", "ACTIVE", "CLOSED"] as const;
export type SprintStatus = (typeof SPRINT_STATUSES)[number];

/** Fields a plain update may change. Status is not one (§5.2, r05b owns it). */
export const SPRINT_UPDATABLE = ["name", "goal", "start_at", "end_at", "capacity"] as const;

/**
 * RFC 3339 with an explicit offset.
 *
 * A bare date is refused rather than assumed: "2026-08-03" means a different
 * instant in every timezone, and a sprint boundary that shifts by a day
 * depending on who reads it is worse than a rejected request (§5.2).
 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export interface SprintInput {
  name?: string;
  goal?: string | null;
  start_at?: string;
  end_at?: string;
  capacity?: number | null;
  /** Rejected if present — transitions are explicit commands (r05b). */
  status?: string;
}

export interface SprintDetail {
  id: string;
  project: string;
  name: string | null;
  goal: string | null;
  status: string | null;
  startAt: string | null;
  endAt: string | null;
  capacity: number | null;
  path: string;
  etag: string;
  resource: unknown;
}

export function isSprintStatus(value: string): value is SprintStatus {
  return (SPRINT_STATUSES as readonly string[]).includes(value);
}

export function sprintPath(project: string, id: string): string {
  return `sprints/${project}/${id}.yaml`;
}

export function findSprint(board: BoardHandle, id: string): SprintDetail | null {
  const row = board.db
    .prepare(
      `SELECT id, project, name, goal, status, start_at, end_at, capacity, path, etag, resource_json
         FROM sprints WHERE id = ? AND state = 'OK'`,
    )
    .get(id) as Record<string, string | number | null> | undefined;

  return row === undefined ? null : toDetail(row);
}

export function listSprints(
  board: BoardHandle,
  project: string,
  status?: string,
): SprintDetail[] {
  const rows = board.db
    .prepare(
      `SELECT id, project, name, goal, status, start_at, end_at, capacity, path, etag, resource_json
         FROM sprints
        WHERE project = ? AND state = 'OK' AND (? IS NULL OR status = ?)
        ORDER BY start_at IS NULL, start_at, id`,
    )
    .all(project, status ?? null, status ?? null) as Array<Record<string, string | number | null>>;

  return rows.map(toDetail);
}

function toDetail(row: Record<string, string | number | null>): SprintDetail {
  return {
    id: String(row.id),
    project: String(row.project),
    name: row.name as string | null,
    goal: row.goal as string | null,
    status: row.status as string | null,
    startAt: row.start_at as string | null,
    endAt: row.end_at as string | null,
    capacity: row.capacity as number | null,
    path: String(row.path),
    etag: String(row.etag),
    resource: JSON.parse(String(row.resource_json)) as unknown,
  };
}

export async function createSprint(
  writable: WritableBoard,
  project: string,
  input: SprintInput,
  actor: Actor,
): Promise<SprintDetail> {
  const board = writable.board;
  requireProject(board, project);

  if (input.status !== undefined && input.status !== "PLANNED") {
    throw new IssueError(
      "E_STATUS_NOT_ALLOWED",
      "Sprints are always created as PLANNED; use the start command to move one.",
    );
  }

  const name = requireName(input.name);
  const startAt = requireInstant(input.start_at, "start_at");
  const endAt = requireInstant(input.end_at, "end_at");
  requireOrder(startAt, endAt);
  const capacity = requireCapacity(input.capacity);

  const id = allocateId(board, project);
  const relative = sprintPath(project, id);
  const absolute = path.join(board.boardRoot, relative);
  if (fs.existsSync(absolute)) {
    throw new IssueError("E_KEY_COLLISION", `${relative} already exists`);
  }

  const now = timestamp(projectTimezone(board, project));
  const contents = render({
    id, name, goal: input.goal ?? null, startAt, endAt, capacity,
  });

  await writable.writer.write({
    kind: "create",
    targetPath: relative,
    contents,
    expectedHash: null,
    event: buildEvent(board.localDirectory, {
      verb: "sprint.created",
      targetKind: "sprint",
      targetUid: id,
      actor: { id: actor.id, kind: actor.kind },
      after: { id, name, status: "PLANNED", capacity },
      detail: { project },
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
  });

  const created = findSprint(board, id);
  if (created === null) {
    throw new IssueError("E_KEY_COLLISION", `${id} was written but could not be read back`);
  }
  return created;
}

export async function updateSprint(
  writable: WritableBoard,
  id: string,
  ifMatch: string | null,
  input: SprintInput,
  actor: Actor,
): Promise<{ sprint: SprintDetail; changed: boolean }> {
  const board = writable.board;
  const sprint = findSprint(board, id);
  if (sprint === null) {
    throw new IssueError("E_UNKNOWN_PROJECT", `No sprint with id ${id}`);
  }

  if (input.status !== undefined) {
    // §5.2: a sprint moves through explicit commands so that the ACTIVE
    // uniqueness rule and the carryover choice live in exactly one place.
    throw new IssueError(
      "E_STATUS_NOT_ALLOWED",
      "Sprint status changes go through the start and close commands, not a field update.",
    );
  }

  if (ifMatch === null) {
    throw new PreconditionRequiredError(sprint.etag);
  }
  if (ifMatch.trim().replace(/^"(.*)"$/, "$1") !== sprint.etag) {
    throw new PreconditionFailedError(sprint.etag, sprint.resource as JsonValue, {});
  }

  const startAt = input.start_at === undefined
    ? sprint.startAt
    : requireInstant(input.start_at, "start_at");
  const endAt = input.end_at === undefined
    ? sprint.endAt
    : requireInstant(input.end_at, "end_at");
  requireOrder(startAt, endAt);

  const absolute = path.join(board.boardRoot, sprint.path);
  const original = fs.readFileSync(absolute, "utf8");
  const patched = patchSprint(original, {
    ...(input.name === undefined ? {} : { name: requireName(input.name) }),
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.start_at === undefined ? {} : { start_at: startAt }),
    ...(input.end_at === undefined ? {} : { end_at: endAt }),
    ...(input.capacity === undefined ? {} : { capacity: requireCapacity(input.capacity) }),
  });

  if (patched === original) {
    return { sprint, changed: false };
  }

  const now = timestamp(projectTimezone(board, sprint.project));
  await writable.writer.write({
    kind: "update",
    targetPath: sprint.path,
    contents: patched,
    expectedHash: fileHash(Buffer.from(original, "utf8")),
    event: buildEvent(board.localDirectory, {
      verb: "sprint.updated",
      targetKind: "sprint",
      targetUid: id,
      actor: { id: actor.id, kind: actor.kind },
      before: { name: sprint.name, capacity: sprint.capacity },
      after: { name: input.name ?? sprint.name, capacity: input.capacity ?? sprint.capacity },
      detail: { project: sprint.project },
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
  });

  const reread = findSprint(board, id);
  if (reread === null) {
    throw new IssueError("E_KEY_COLLISION", `${id} could not be read back`);
  }
  return { sprint: reread, changed: true };
}

export class SprintNotEmptyError extends Error {
  readonly code = "E_SPRINT_NOT_EMPTY";
  readonly issues: string[];
  readonly strategies = ["release"];

  constructor(id: string, issues: string[]) {
    super(`${id} still holds ${issues.length} issue(s).`);
    this.name = "SprintNotEmptyError";
    this.issues = issues;
  }
}

/**
 * Deletes a PLANNED sprint.
 *
 * Only PLANNED. An ACTIVE sprint is the board people are looking at, and a
 * CLOSED one is the record of what happened — the carryover events point at it.
 *
 * A sprint holding issues is refused until the caller says what happens to
 * them, following the same rule as deleting a parent issue (r02a). Deleting it
 * regardless would leave every one of those issues pointing at a sprint that no
 * longer exists, which is precisely what r11a quarantines as a dangling
 * reference — the board would break itself on request.
 */
export async function deleteSprint(
  writable: WritableBoard,
  id: string,
  ifMatch: string | null,
  actor: Actor,
  strategy: "release" | null = null,
): Promise<void> {
  const board = writable.board;
  const sprint = findSprint(board, id);
  if (sprint === null) {
    throw new IssueError("E_UNKNOWN_PROJECT", `No sprint with id ${id}`);
  }

  if (sprint.status !== "PLANNED") {
    throw new IssueError(
      "E_SPRINT_NOT_DELETABLE",
      `${id} is ${sprint.status} and cannot be deleted.`,
      sprint.status === "ACTIVE"
        ? "Close it first."
        : "A closed sprint is the record of what happened.",
    );
  }

  const held = (
    board.db
      .prepare("SELECT key FROM issues WHERE sprint_id = ? AND state = 'OK' ORDER BY key")
      .all(id) as Array<{ key: string }>
  ).map((row) => row.key);

  if (held.length > 0 && strategy === null) {
    throw new SprintNotEmptyError(id, held);
  }

  if (ifMatch === null) {
    throw new PreconditionRequiredError(sprint.etag);
  }
  if (ifMatch.trim().replace(/^"(.*)"$/, "$1") !== sprint.etag) {
    throw new PreconditionFailedError(sprint.etag, sprint.resource as JsonValue, {});
  }

  // Issues first. Stopping halfway then leaves a sprint that still holds them,
  // which is recoverable; the other order leaves dangling references.
  for (const key of held) {
    await releaseIssue(writable, key, actor);
  }

  const absolute = path.join(board.boardRoot, sprint.path);
  const now = timestamp(projectTimezone(board, sprint.project));
  await writable.writer.write({
    kind: "delete",
    targetPath: sprint.path,
    contents: null,
    expectedHash: fileHash(fs.readFileSync(absolute)),
    event: buildEvent(board.localDirectory, {
      verb: "sprint.deleted",
      targetKind: "sprint",
      targetUid: id,
      actor: { id: actor.id, kind: actor.kind },
      before: { id, name: sprint.name, status: sprint.status },
      detail: { project: sprint.project, released: held.length },
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
  });
}

/** Removes an issue's sprint, leaving its backlog position alone (ADR-005 §1). */
async function releaseIssue(
  writable: WritableBoard,
  key: string,
  actor: Actor,
): Promise<void> {
  const board = writable.board;
  const row = board.db
    .prepare("SELECT path, uid FROM issues WHERE key = ? AND state = 'OK'")
    .get(key) as { path: string; uid: string } | undefined;
  if (!row) {
    return;
  }

  const absolute = path.join(board.boardRoot, row.path);
  const original = fs.readFileSync(absolute, "utf8");
  const patched = original.replace(/^sprint: .*\n/m, "");
  if (patched === original) {
    return;
  }

  const now = timestamp(projectTimezone(board, key.split("-")[0]));
  await writable.writer.write({
    kind: "update",
    targetPath: row.path,
    contents: patched,
    expectedHash: fileHash(Buffer.from(original, "utf8")),
    event: buildEvent(board.localDirectory, {
      verb: "issue.updated",
      targetKind: "issue",
      targetUid: row.uid,
      actor: { id: actor.id, kind: actor.kind },
      before: { sprint: null },
      after: { sprint: null },
      detail: { key, reason: "sprint_deleted" },
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
  });
}

export interface SprintPlan {
  id: string;
  capacity: number | null;
  /** Points of the estimated issues in scope. */
  committed: number;
  /** Issues with no estimate, counted rather than folded in as zero. */
  unestimated: number;
  issues: number;
  /** How far past capacity, or null when there is no capacity to exceed. */
  over: number | null;
}

/**
 * What a sprint holds, against what it said it could hold.
 *
 * Unestimated issues are reported separately rather than added as zero. Folding
 * them in would make the total look like it covered the whole scope when it
 * covers only the part somebody has sized — the same reason R20 keeps them out
 * of the burndown denominator (D8).
 *
 * The comparison is advisory. Exceeding capacity warns and blocks nothing —
 * neither adding an issue nor starting the sprint (PRD R6, AC5). A plan is an
 * estimate, and a tool that refuses to record what a team decided to attempt is
 * describing a different team.
 */
export function planOf(board: BoardHandle, id: string): SprintPlan | null {
  const sprint = findSprint(board, id);
  if (sprint === null) {
    return null;
  }

  const row = board.db
    .prepare(
      `SELECT COALESCE(SUM(points), 0) AS committed,
              SUM(CASE WHEN points IS NULL THEN 1 ELSE 0 END) AS unestimated,
              COUNT(*) AS issues
         FROM issues WHERE sprint_id = ? AND state = 'OK'`,
    )
    .get(id) as { committed: number; unestimated: number; issues: number };

  const committed = Number(row.committed);
  return {
    id,
    capacity: sprint.capacity,
    committed,
    unestimated: Number(row.unestimated ?? 0),
    issues: Number(row.issues),
    over: sprint.capacity === null ? null : Math.max(0, committed - sprint.capacity),
  };
}

/** Terminal states. Work here is not carried into the next sprint. */
const SETTLED = new Set(["DONE", "CANCELLED"]);

export class SprintConflictError extends Error {
  readonly code = "E_SPRINT_CONFLICT";
  readonly active: string[];
  readonly paths: string[];

  constructor(project: string, active: string[], paths: string[]) {
    super(`${project} has ${active.length} active sprints and cannot start or close one.`);
    this.name = "SprintConflictError";
    this.active = active;
    this.paths = paths;
  }
}

export class SprintStateError extends Error {
  readonly code = "E_SPRINT_STATE";
  readonly status: string | null;
  readonly active: string | null;

  constructor(message: string, status: string | null, active: string | null = null) {
    super(message);
    this.name = "SprintStateError";
    this.status = status;
    this.active = active;
  }
}

/**
 * Refuses to act while the project disagrees with itself about what is active.
 *
 * A merge can leave two ACTIVE sprints; r11a detects that and reports it, but
 * has no command to block. This is the command. Starting or closing from an
 * ambiguous state would pick one of the two on the team's behalf, and which one
 * is exactly what nobody has decided yet (§5.6).
 */
function refuseWhileConflicted(board: BoardHandle, project: string): void {
  const rows = board.db
    .prepare(
      "SELECT id, path FROM sprints WHERE project = ? AND status = 'ACTIVE' AND state = 'OK'",
    )
    .all(project) as Array<{ id: string; path: string }>;

  if (rows.length > 1) {
    throw new SprintConflictError(
      project,
      rows.map((row) => row.id),
      rows.map((row) => row.path),
    );
  }
}

export interface StartResult {
  sprint: SprintDetail;
  plan: SprintPlan;
  /** Present when the scope is past capacity. Advisory only (PRD R6, AC5). */
  warning: string | null;
}

export async function startSprint(
  writable: WritableBoard,
  id: string,
  actor: Actor,
): Promise<StartResult> {
  const board = writable.board;
  const sprint = requireSprint(board, id);
  refuseWhileConflicted(board, sprint.project);

  if (sprint.status !== "PLANNED") {
    throw new SprintStateError(
      `${id} is ${sprint.status} and cannot be started.`,
      sprint.status,
    );
  }

  const active = board.db
    .prepare(
      "SELECT id FROM sprints WHERE project = ? AND status = 'ACTIVE' AND state = 'OK' LIMIT 1",
    )
    .get(sprint.project) as { id: string } | undefined;

  if (active) {
    // §5.2: one active sprint per project. Told which one, so the caller can
    // close it rather than guess why the request failed.
    throw new SprintStateError(
      `${sprint.project} already has an active sprint.`,
      sprint.status,
      active.id,
    );
  }

  await writeStatus(writable, sprint, "ACTIVE", actor, {});

  const started = requireSprint(board, id);
  const plan = planOf(board, id);
  return {
    sprint: started,
    plan: plan as SprintPlan,
    warning:
      plan && plan.over !== null && plan.over > 0
        ? `capacity ${plan.capacity} 대비 ${plan.committed} 포인트(+${plan.over}) 초과`
        : null,
  };
}

export interface CloseRequest {
  /** Absent means "tell me what would happen"; the sprint stays open. */
  carryOver?: { to: string | null };
}

export interface CloseResult {
  /** True when nothing was changed because no carry-over choice was made. */
  pending: boolean;
  sprint: SprintDetail;
  unfinished: string[];
  /** Cancelled issues, listed apart so "resolved" and "abandoned" stay distinct. */
  cancelled: string[];
  carriedTo?: string | null;
}

/**
 * Closes an active sprint, moving whatever is unfinished.
 *
 * Called without a choice it changes nothing and answers with what it would
 * move. Closing is where a sprint's leftovers get decided, and deciding that
 * silently — pushing everything forward, or dropping it into the backlog —
 * makes the tool responsible for a judgement the team should make.
 *
 * `CANCELLED` counts as finished. The work will not happen, so carrying it
 * would move a decision not to do something into next sprint's scope. It is
 * still reported separately, for the same reason S1-D5 distinguishes a blocker
 * that finished from one that was abandoned.
 */
export async function closeSprint(
  writable: WritableBoard,
  id: string,
  request: CloseRequest,
  actor: Actor,
): Promise<CloseResult> {
  const board = writable.board;
  const sprint = requireSprint(board, id);
  refuseWhileConflicted(board, sprint.project);

  if (sprint.status !== "ACTIVE") {
    throw new SprintStateError(`${id} is ${sprint.status} and cannot be closed.`, sprint.status);
  }

  const held = board.db
    .prepare(
      "SELECT key, status FROM issues WHERE sprint_id = ? AND state = 'OK' ORDER BY key",
    )
    .all(id) as Array<{ key: string; status: string | null }>;

  const unfinished = held
    .filter((row) => row.status === null || !SETTLED.has(row.status))
    .map((row) => row.key);
  const cancelled = held.filter((row) => row.status === "CANCELLED").map((row) => row.key);

  if (request.carryOver === undefined) {
    return { pending: true, sprint, unfinished, cancelled };
  }

  const target = request.carryOver.to;
  if (target !== null) {
    if (target === id) {
      throw new IssueError("E_INVALID_CARRY_OVER", "A sprint cannot carry work into itself.");
    }
    const destination = findSprint(board, target);
    if (destination === null) {
      throw new IssueError("E_UNKNOWN_SPRINT", `No sprint with id ${target} to carry work into.`);
    }
    if (destination.status === "CLOSED") {
      throw new IssueError(
        "E_SPRINT_CLOSED",
        `${target} is closed and cannot receive carried-over work.`,
      );
    }
  }

  // Issues first. Stopping partway leaves a sprint that is still ACTIVE and
  // still holds them, which the next attempt resolves; closing first would
  // leave work attached to a finished sprint.
  for (const key of unfinished) {
    await moveIssueSprint(writable, key, target, actor, id);
  }

  await writeStatus(writable, sprint, "CLOSED", actor, {
    carried: unfinished.length,
    carried_to: target,
  });

  return {
    pending: false,
    sprint: requireSprint(board, id),
    unfinished,
    cancelled,
    carriedTo: target,
  };
}

function requireSprint(board: BoardHandle, id: string): SprintDetail {
  const sprint = findSprint(board, id);
  if (sprint === null) {
    throw new IssueError("E_UNKNOWN_PROJECT", `No sprint with id ${id}`);
  }
  return sprint;
}

async function writeStatus(
  writable: WritableBoard,
  sprint: SprintDetail,
  status: SprintStatus,
  actor: Actor,
  detail: Record<string, JsonValue>,
): Promise<void> {
  const board = writable.board;
  const absolute = path.join(board.boardRoot, sprint.path);
  const original = fs.readFileSync(absolute, "utf8");
  const patched = original.replace(/^status: .*$/m, `status: ${status}`);

  const now = timestamp(projectTimezone(board, sprint.project));
  await writable.writer.write({
    kind: "update",
    targetPath: sprint.path,
    contents: patched,
    expectedHash: fileHash(Buffer.from(original, "utf8")),
    event: buildEvent(board.localDirectory, {
      verb: status === "ACTIVE" ? "sprint.started" : "sprint.closed",
      targetKind: "sprint",
      targetUid: sprint.id,
      actor: { id: actor.id, kind: actor.kind },
      before: { status: sprint.status },
      after: { status },
      detail: { project: sprint.project, ...detail },
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
  });
}

/** Repoints one issue's sprint, leaving its backlog position alone. */
async function moveIssueSprint(
  writable: WritableBoard,
  key: string,
  to: string | null,
  actor: Actor,
  from: string,
): Promise<void> {
  const board = writable.board;
  const row = board.db
    .prepare("SELECT path, uid FROM issues WHERE key = ? AND state = 'OK'")
    .get(key) as { path: string; uid: string } | undefined;
  if (!row) {
    return;
  }

  const absolute = path.join(board.boardRoot, row.path);
  const original = fs.readFileSync(absolute, "utf8");
  const patched = to === null
    ? original.replace(/^sprint: .*\n/m, "")
    : original.replace(/^sprint: .*$/m, `sprint: ${to}`);
  if (patched === original) {
    return;
  }

  const now = timestamp(projectTimezone(board, key.split("-")[0]));
  await writable.writer.write({
    kind: "update",
    targetPath: row.path,
    contents: patched,
    expectedHash: fileHash(Buffer.from(original, "utf8")),
    event: buildEvent(board.localDirectory, {
      verb: "issue.updated",
      targetKind: "issue",
      targetUid: row.uid,
      actor: { id: actor.id, kind: actor.kind },
      before: { sprint: from },
      after: { sprint: to },
      detail: { key, reason: "sprint_closed" },
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
  });
}

// ── rendering and validation ────────────────────────────────────────────────

interface RenderInput {
  id: string;
  name: string;
  goal: string | null;
  startAt: string | null;
  endAt: string | null;
  capacity: number | null;
}

export function render(input: RenderInput): string {
  const lines = [
    `id: ${input.id}`,
    `name: ${yamlScalar(input.name)}`,
    `status: PLANNED`,
  ];
  if (input.goal !== null && input.goal !== "") {
    lines.push(`goal: ${yamlScalar(input.goal)}`);
  }
  if (input.startAt !== null) {
    lines.push(`start_at: ${yamlScalar(input.startAt)}`);
  }
  if (input.endAt !== null) {
    lines.push(`end_at: ${yamlScalar(input.endAt)}`);
  }
  if (input.capacity !== null) {
    // Story points (D8). The project's estimation unit is fixed, so there is
    // no unit to record alongside it and no hours form to accept.
    lines.push(`capacity: ${input.capacity}`);
  }
  lines.push("schema_version: 1");
  return `${lines.join("\n")}\n`;
}

export function patchSprint(original: string, fields: Record<string, unknown>): string {
  let lines = original.split("\n");

  for (const [key, value] of Object.entries(fields)) {
    const index = lines.findIndex((line) => new RegExp(`^${key}:(\\s|$)`).test(line));
    if (value === null || value === "") {
      if (index !== -1) {
        lines = [...lines.slice(0, index), ...lines.slice(index + 1)];
      }
      continue;
    }
    const rendered = typeof value === "number" ? String(value) : yamlScalar(String(value));
    const entry = `${key}: ${rendered}`;
    if (index === -1) {
      const anchor = lines.findIndex((line) => /^schema_version:/.test(line));
      lines = anchor === -1
        ? [...lines, entry]
        : [...lines.slice(0, anchor), entry, ...lines.slice(anchor)];
    } else {
      lines[index] = entry;
    }
  }

  return lines.join("\n");
}

function requireProject(board: BoardHandle, project: string): void {
  const row = board.db.prepare("SELECT key FROM projects WHERE key = ?").get(project);
  if (!row) {
    throw new IssueError("E_UNKNOWN_PROJECT", `No project "${project}" on this board`);
  }
}

function requireName(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") {
    throw new IssueError("E_INVALID_TITLE", "A sprint needs a name");
  }
  return trimmed;
}

function requireInstant(value: string | undefined, field: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (!RFC3339.test(value)) {
    throw new IssueError(
      "E_INVALID_INSTANT",
      `${field} must be an RFC 3339 timestamp with an offset.`,
      'For example 2026-08-03T09:00:00+09:00. A bare date means a different instant in every timezone.',
    );
  }
  return value;
}

function requireOrder(startAt: string | null, endAt: string | null): void {
  if (startAt === null || endAt === null) {
    return;
  }
  // Compared as instants, not strings: +09:00 and Z sort differently as text
  // and the same moment can be written either way.
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    throw new IssueError(
      "E_INVALID_INSTANT",
      "end_at must be after start_at.",
      "Sprints that end before they begin are not a shape anything downstream can read.",
    );
  }
}

function requireCapacity(value: number | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new IssueError(
      "E_INVALID_POINTS",
      "capacity must be a whole number of story points, or omitted.",
    );
  }
  return value;
}

/** `LJ-S3`, numbered from the highest ever used so a deleted id is not reused. */
function allocateId(board: BoardHandle, project: string): string {
  const rows = board.db
    .prepare("SELECT id FROM sprints WHERE project = ?")
    .all(project) as Array<{ id: string }>;

  let highest = 0;
  for (const row of rows) {
    const match = /-S(\d+)$/.exec(row.id);
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return `${project}-S${highest + 1}`;
}

export { formatEtag };
