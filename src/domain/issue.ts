import fs from "node:fs";
import path from "node:path";

import { createUlid } from "../bootstrap/identifier.ts";
import { yamlScalar } from "../bootstrap/scaffold.ts";
import type { BoardHandle, WritableBoard } from "../storage/board.ts";
import { findIssue, type IssueDetail } from "../storage/board.ts";
import { issuePath } from "../storage/layout.ts";
import { buildEvent } from "./events.ts";
import { validateParent } from "./hierarchy.ts";
import { between } from "./rank.ts";
import { refuseIfTargetQuarantined } from "./update.ts";

export const ISSUE_TYPES = [
  "epic",
  "story",
  "task",
  "bug",
  "spike",
  "subtask",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/** Creation always starts here; other states are reached through transitions. */
export const INITIAL_STATUS = "BACKLOG";
export const SCHEMA_VERSION = 1;
export const MAX_POINTS = 100;

export type IssueErrorCode =
  | "E_UNKNOWN_PROJECT"
  | "E_INVALID_TYPE"
  | "E_INVALID_TITLE"
  | "E_INVALID_POINTS"
  | "E_STATUS_NOT_ALLOWED"
  | "E_INVALID_LABEL"
  | "E_KEY_COLLISION"
  | "E_PARENT_NOT_ALLOWED"
  | "E_PARENT_NOT_FOUND"
  | "E_PARENT_CYCLE"
  | "E_CHILDREN_PRESENT"
  | "E_STRATEGY_IMPOSSIBLE"
  | "E_INVALID_LINK_KIND"
  | "E_LINK_SELF"
  | "E_LINK_TARGET_NOT_FOUND"
  | "E_LINK_NOT_FOUND"
  | "E_INVALID_INSTANT"
  | "E_SPRINT_NOT_DELETABLE"
  | "E_UNKNOWN_SPRINT"
  | "E_SPRINT_CLOSED"
  | "E_INVALID_CARRY_OVER";

export class IssueError extends Error {
  readonly code: IssueErrorCode;
  readonly detail: string | null;

  constructor(code: IssueErrorCode, message: string, detail: string | null = null) {
    super(message);
    this.name = "IssueError";
    this.code = code;
    this.detail = detail;
  }
}

export interface AcceptanceInput {
  text: string;
  done?: boolean;
}

export interface CreateIssueInput {
  project: string;
  type: string;
  title: string;
  description?: string;
  labels?: string[];
  points?: number | null;
  assignee?: string | null;
  acceptance?: AcceptanceInput[];
  /** uid of the parent issue. Checked against the type rules in §5.1. */
  parent?: string | null;
  /** Rejected if present — see S1-D1. Accepted as a parameter only to say so. */
  status?: string;
  /** Forwarded to the write journal so a crash mid-create is still idempotent. */
  idempotency?: { actorId: string; key: string };
}

export interface Actor {
  id: string;
  kind: "human" | "agent";
  /**
   * The PAT that authenticated the request, when one did.
   *
   * Carried on the actor rather than passed alongside it, because every event
   * an action produces has to name it (AC16) and a parallel parameter is one
   * each call site can forget.
   */
  tokenId?: string | null;
}

export async function createIssue(
  writable: WritableBoard,
  input: CreateIssueInput,
  actor: Actor,
): Promise<IssueDetail> {
  const board = writable.board;
  const project = requireProject(board, input.project);
  const type = requireType(input.type);
  const title = requireTitle(input.title);
  const points = requirePoints(input.points);
  const labels = requireLabels(input.labels ?? []);

  if (input.status !== undefined && input.status !== INITIAL_STATUS) {
    // Every state change goes through the transition endpoint so that gating
    // and event verbs are decided in exactly one place (S1-D2). Allowing a
    // starting status here would fork that check.
    throw new IssueError(
      "E_STATUS_NOT_ALLOWED",
      `Issues are always created as ${INITIAL_STATUS}; use a transition to move them.`,
    );
  }

  // Before a uid is minted, so a rejected parent leaves no key consumed.
  const parent =
    input.parent === undefined || input.parent === null
      ? null
      : (refuseIfTargetQuarantined(board, input.parent),
         validateParent(board, type, null, input.parent));

  const uid = createUlid();
  const key = allocateKey(board, project.key);
  // Ranked on arrival, appended to the end. Leaving it unset would put new
  // issues ahead of every ranked one — SQLite sorts NULL first — so the first
  // deliberate reorder would appear to send the card the wrong way.
  const backlogRank = nextBacklogRank(board, project.key);
  const now = timestamp(project.timezone);
  const relative = issuePath(project.key, key);
  const absolute = path.join(board.boardRoot, relative);

  if (fs.existsSync(absolute)) {
    throw new IssueError(
      "E_KEY_COLLISION",
      `${relative} already exists`,
      "The index may be stale; run localjira index rebuild.",
    );
  }

  const contents = renderIssueFile({
    uid,
    key,
    type,
    title,
    points,
    labels,
    assignee: input.assignee ?? null,
    acceptance: input.acceptance ?? [],
    parent: parent?.uid ?? null,
    backlogRank,
    createdAt: now,
    createdByKind: actor.kind,
    description: input.description ?? "",
  });

  // Through the writer, so the file, the index and the event move together and
  // a crash anywhere in between is replayable (r09).
  await writable.writer.write({
    kind: "create",
    targetPath: relative,
    contents,
    expectedHash: null,
    event: buildEvent(board.localDirectory, {
      verb: "issue.created",
      targetKind: "issue",
      targetUid: uid,
      actor,
      after: { key, type, title, status: INITIAL_STATUS, points },
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
    idempotency: input.idempotency,
  });

  const found = findIssue(board, key);
  if (!found || !("issue" in found)) {
    throw new IssueError(
      "E_KEY_COLLISION",
      `${key} was written but could not be read back`,
    );
  }
  return found.issue;
}

interface ProjectRow {
  key: string;
  timezone: string | null;
}

function requireProject(board: BoardHandle, key: string): ProjectRow {
  const row = board.db
    .prepare("SELECT key, timezone FROM projects WHERE key = ?")
    .get(key) as ProjectRow | undefined;

  if (!row) {
    const known = (
      board.db.prepare("SELECT key FROM projects ORDER BY key").all() as Array<{ key: string }>
    ).map((project) => project.key);
    throw new IssueError(
      "E_UNKNOWN_PROJECT",
      `No project "${key}" on this board`,
      known.length > 0 ? `Known projects: ${known.join(", ")}` : "The board has no projects.",
    );
  }
  return row;
}

/** The rank that puts a new issue at the end of the project backlog. */
function nextBacklogRank(board: BoardHandle, project: string): string {
  const row = board.db
    .prepare(
      `SELECT backlog_rank FROM issues
        WHERE project = ? AND state = 'OK' AND backlog_rank IS NOT NULL
        ORDER BY backlog_rank DESC, uid DESC LIMIT 1`,
    )
    .get(project) as { backlog_rank: string } | undefined;

  try {
    return between(row?.backlog_rank ?? null, null);
  } catch {
    // The tail has run out of room. Creation must not fail for that — the next
    // deliberate move rebalances, and until then the uid tie-break orders it.
    return row?.backlog_rank ?? between(null, null);
  }
}

function requireType(value: string): IssueType {
  if (!(ISSUE_TYPES as readonly string[]).includes(value)) {
    throw new IssueError(
      "E_INVALID_TYPE",
      `"${value}" is not an issue type`,
      `Allowed: ${ISSUE_TYPES.join(", ")}`,
    );
  }
  return value as IssueType;
}

function requireTitle(value: string): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") {
    throw new IssueError("E_INVALID_TITLE", "A title is required");
  }
  if ([...trimmed].some((char) => isControl(char))) {
    throw new IssueError("E_INVALID_TITLE", "A title may not contain control characters");
  }
  return trimmed;
}

function requirePoints(value: number | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  // Unestimated is null, not 0 — the burndown excludes the former and counts
  // the latter (D8), so they cannot be conflated.
  if (!Number.isInteger(value) || value < 0 || value > MAX_POINTS) {
    throw new IssueError(
      "E_INVALID_POINTS",
      `points must be an integer between 0 and ${MAX_POINTS}, or omitted`,
    );
  }
  return value;
}

function requireLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  for (const label of labels) {
    const trimmed = label.trim();
    if (trimmed === "" || /[\s,]/.test(trimmed)) {
      throw new IssueError(
        "E_INVALID_LABEL",
        `"${label}" is not a valid label`,
        "Labels may not be empty or contain whitespace or commas.",
      );
    }
    seen.add(trimmed);
  }
  return [...seen].sort();
}

/**
 * Allocates the next display key from the highest number ever used.
 *
 * Former keys are included so a number released by rekeying is never handed
 * out again — a commit trailer or someone's memory may still point at it.
 */
function allocateKey(board: BoardHandle, project: string): string {
  const keys = (
    board.db
      .prepare(
        `SELECT key FROM issues WHERE project = ?
         UNION ALL
         SELECT key FROM issue_former_keys WHERE project = ?`,
      )
      .all(project, project) as Array<{ key: string }>
  ).map((row) => row.key);

  // Quarantined files have no issues row after a full rebuild: they never
  // parsed, so nothing was inserted for them. Left out, this hands back a number
  // whose file already exists — and the collision check then refuses *every* new
  // issue until somebody repairs that one file. The path is the only place the
  // key survives, so read it from there (§5.6).
  //
  // A separate query, not another UNION branch: SQLite names a compound
  // select's columns after the first branch, so a `path` unioned onto `key`
  // arrives as `key` and reads as a key that happens to look like a path.
  const quarantined = (
    board.db
      .prepare("SELECT path FROM index_errors WHERE path LIKE ?")
      .all(`issues/${project}/%`) as Array<{ path: string }>
  ).map((row) => keyFromIssuePath(row.path));

  let highest = 0;
  for (const key of [...keys, ...quarantined]) {
    const match = /^.+-(\d+)$/.exec(key);
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return `${project}-${highest + 1}`;
}

/** `issues/LJ/LJ-12.md` → `LJ-12`. */
function keyFromIssuePath(value: string): string {
  return /^issues\/[^/]+\/(.+)\.md$/.exec(value)?.[1] ?? "";
}

interface RenderInput {
  uid: string;
  key: string;
  type: IssueType;
  title: string;
  points: number | null;
  labels: string[];
  assignee: string | null;
  acceptance: AcceptanceInput[];
  parent: string | null;
  backlogRank: string;
  createdAt: string;
  createdByKind: Actor["kind"];
  description: string;
}

/**
 * Renders the `acceptance:` block sequence.
 *
 * Shared by creation and update so a criterion edited later keeps the shape it
 * was created with — ids stay dense and positional, and `done` is always
 * spelled out rather than left to YAML's absent-means-false reading.
 *
 * Structured in frontmatter, never as a body heading: the body is free prose
 * and the parser must not read meaning out of it.
 */
export function renderAcceptance(items: AcceptanceInput[]): string[] {
  if (items.length === 0) {
    return [];
  }
  const lines = ["acceptance:"];
  items.forEach((item, index) => {
    lines.push(`  - id: ac${index + 1}`);
    lines.push(`    text: ${yamlScalar(item.text)}`);
    lines.push(`    done: ${item.done === true}`);
  });
  return lines;
}

export function renderIssueFile(input: RenderInput): string {
  const lines: string[] = [
    `uid: ${input.uid}`,
    `key: ${input.key}`,
    "former_keys: []",
    `type: ${input.type}`,
    `title: ${yamlScalar(input.title)}`,
    `status: ${INITIAL_STATUS}`,
  ];

  if (input.parent) {
    lines.push(`parent: ${input.parent}`);
  }
  if (input.assignee) {
    lines.push(`assignee: ${yamlScalar(input.assignee)}`);
  }
  if (input.points !== null) {
    lines.push(`points: ${input.points}`);
  }
  if (input.labels.length > 0) {
    lines.push(`labels: [${input.labels.map(yamlScalar).join(", ")}]`);
  }
  lines.push(`backlog_rank: "${input.backlogRank}"`);
  lines.push(...renderAcceptance(input.acceptance));

  lines.push(
    `created_at: ${input.createdAt}`,
    `updated_at: ${input.createdAt}`,
    `created_by_kind: ${input.createdByKind}`,
    `last_actor_kind: ${input.createdByKind}`,
    // Display and history only. The concurrency validator is the ETag, never
    // this counter: two clones editing offline both produce rev 2 from rev 1,
    // so equal revs would read as "no change" and unequal ones as a conflict
    // that isn't. Keeping it out of the decision is what makes it safe to show.
    "rev: 1",
    `schema_version: ${SCHEMA_VERSION}`,
  );

  const body = input.description === "" ? "" : ensureTrailingNewline(input.description);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/**
 * The offset later writes must stamp with.
 *
 * A missing project falls back to UTC rather than throwing: the issue exists,
 * so refusing to timestamp an edit to it would be worse than a plain `Z`.
 */
export function projectTimezone(board: BoardHandle, key: string): string | null {
  const row = board.db
    .prepare("SELECT timezone FROM projects WHERE key = ?")
    .get(key) as { timezone: string | null } | undefined;
  return row?.timezone ?? null;
}

/** RFC 3339 with the project's offset, so a local day boundary is readable. */
export function timestamp(timezone: string | null, now: Date = new Date()): string {
  if (!timezone) {
    return `${now.toISOString().slice(0, 19)}Z`;
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now);

  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  const local = `${get("year")}-${get("month")}-${get("day")}T${normaliseHour(get("hour"))}:${get("minute")}:${get("second")}`;

  return `${local}${offsetOf(timezone, now)}`;
}

function normaliseHour(hour: string): string {
  return hour === "24" ? "00" : hour;
}

function offsetOf(timezone: string, now: Date): string {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName")?.value;

  if (!name || name === "GMT") {
    return "Z";
  }
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!match) {
    return "Z";
  }
  const offset = `${match[1]}${match[2]}:${match[3] ?? "00"}`;
  // RFC 3339 permits +00:00, but Z is the conventional spelling for UTC and
  // keeps generated timestamps comparable with the ones M0 writes.
  return offset === "+00:00" || offset === "-00:00" ? "Z" : offset;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}
