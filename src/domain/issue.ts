import fs from "node:fs";
import path from "node:path";

import { createUlid } from "../bootstrap/identifier.ts";
import { yamlScalar } from "../bootstrap/scaffold.ts";
import type { BoardHandle } from "../storage/board.ts";
import { findIssue, type IssueDetail } from "../storage/board.ts";
import { issuePath } from "../storage/layout.ts";
import { incrementalSync } from "../storage/reindex.ts";

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
  | "E_KEY_COLLISION";

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
  /** Rejected if present — see S1-D1. Accepted as a parameter only to say so. */
  status?: string;
}

export interface Actor {
  id: string;
  kind: "human" | "agent";
}

export function createIssue(
  board: BoardHandle,
  input: CreateIssueInput,
  actor: Actor,
): IssueDetail {
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

  const uid = createUlid();
  const key = allocateKey(board, project.key);
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

  writeFileAtomic(
    absolute,
    renderIssueFile({
      uid,
      key,
      type,
      title,
      points,
      labels,
      assignee: input.assignee ?? null,
      acceptance: input.acceptance ?? [],
      createdAt: now,
      createdByKind: actor.kind,
      description: input.description ?? "",
    }),
  );

  // r09 replaces this with the outbox write path; until then the index is
  // refreshed the same way any external edit is picked up.
  incrementalSync(board.boardRoot, board.db);

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
  const rows = board.db
    .prepare(
      `SELECT key FROM issues WHERE project = ?
       UNION ALL
       SELECT key FROM issue_former_keys WHERE project = ?`,
    )
    .all(project, project) as Array<{ key: string }>;

  let highest = 0;
  for (const row of rows) {
    const match = /^.+-(\d+)$/.exec(row.key);
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return `${project}-${highest + 1}`;
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
  createdAt: string;
  createdByKind: Actor["kind"];
  description: string;
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

  if (input.assignee) {
    lines.push(`assignee: ${yamlScalar(input.assignee)}`);
  }
  if (input.points !== null) {
    lines.push(`points: ${input.points}`);
  }
  if (input.labels.length > 0) {
    lines.push(`labels: [${input.labels.map(yamlScalar).join(", ")}]`);
  }
  if (input.acceptance.length > 0) {
    lines.push("acceptance:");
    input.acceptance.forEach((item, index) => {
      // Structured in frontmatter, never as a body heading: the body is free
      // prose and the parser must not read meaning out of it.
      lines.push(`  - id: ac${index + 1}`);
      lines.push(`    text: ${yamlScalar(item.text)}`);
      lines.push(`    done: ${item.done === true}`);
    });
  }

  lines.push(
    `created_at: ${input.createdAt}`,
    `updated_at: ${input.createdAt}`,
    `created_by_kind: ${input.createdByKind}`,
    `last_actor_kind: ${input.createdByKind}`,
    `schema_version: ${SCHEMA_VERSION}`,
  );

  const body = input.description === "" ? "" : ensureTrailingNewline(input.description);
  return `---\n${lines.join("\n")}\n---\n${body}`;
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

function writeFileAtomic(target: string, contents: string): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.tmp`);

  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, "w", 0o644);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, target);
    syncDirectory(directory);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The original error is the one that matters.
      }
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function syncDirectory(directory: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch {
    // Not available on every filesystem; rename is still atomic without it.
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}
