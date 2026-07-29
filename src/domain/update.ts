import fs from "node:fs";
import path from "node:path";

import { createUlid } from "../bootstrap/identifier.ts";
import { yamlScalar } from "../bootstrap/scaffold.ts";
import type { JsonValue } from "../storage/jcs.ts";
import { findIssue, type IssueDetail, type WritableBoard } from "../storage/board.ts";
import { fileHash, parseMarkdownResource } from "../storage/resource.ts";
import {
  ISSUE_TYPES,
  IssueError,
  MAX_POINTS,
  projectTimezone,
  renderAcceptance,
  timestamp,
  type AcceptanceInput,
  type Actor,
  type IssueType,
} from "./issue.ts";
import { buildEvent } from "./events.ts";
import { canHaveChildren, childrenOf, validateParent } from "./hierarchy.ts";
import { declaredLinks, validateLink, type Link } from "./links.ts";
import { isQuarantinedUid, quarantineOf } from "../storage/integrity.ts";
import {
  allowedTargets,
  isStatus,
  requiresAdmin,
  shouldRecordBlockedFrom,
  STATUSES,
  type Status,
} from "./transition.ts";

/** Fields a plain update may change. Status is deliberately absent (S1-D2). */
export const UPDATABLE = [
  "title",
  "points",
  "labels",
  "assignee",
  "acceptance",
  "parent",
  "sprint",
  "description",
] as const;
export type UpdatableField = (typeof UPDATABLE)[number];

export interface UpdateIssueInput {
  title?: string;
  points?: number | null;
  labels?: string[];
  assignee?: string | null;
  acceptance?: AcceptanceInput[];
  /** uid of the parent, or null to detach. */
  parent?: string | null;
  /** Sprint id, or null to send the issue back to the backlog. */
  sprint?: string | null;
  description?: string;
  /** Rejected if present — transitions have their own endpoint. */
  status?: string;
}

export interface FieldConflict {
  current: JsonValue;
  requested: JsonValue;
}

export class PreconditionRequiredError extends Error {
  readonly code = "E_PRECONDITION_REQUIRED";
  readonly currentEtag: string;

  constructor(currentEtag: string) {
    super("If-Match is required for updates; last-write-wins is not allowed.");
    this.name = "PreconditionRequiredError";
    this.currentEtag = currentEtag;
  }
}

export class PreconditionFailedError extends Error {
  readonly code = "E_PRECONDITION_FAILED";
  readonly currentEtag: string;
  readonly document: JsonValue;
  readonly conflicts: Record<string, FieldConflict>;

  constructor(
    currentEtag: string,
    document: JsonValue,
    conflicts: Record<string, FieldConflict>,
  ) {
    super("The issue changed since it was read.");
    this.name = "PreconditionFailedError";
    this.currentEtag = currentEtag;
    this.document = document;
    this.conflicts = conflicts;
  }
}

export interface UpdateResult {
  issue: IssueDetail;
  /** False when the request asked for values the issue already had. */
  changed: boolean;
}

/**
 * Applies a field update under optimistic concurrency.
 *
 * `If-Match` is required rather than optional: making it optional would leave
 * a silent last-write-wins path available, and the one caller who forgets the
 * header is exactly the one who overwrites someone's work (ADR-003).
 */
export async function updateIssue(
  writable: WritableBoard,
  key: string,
  ifMatch: string | null,
  input: UpdateIssueInput,
  actor: Actor,
): Promise<UpdateResult> {
  const board = writable.board;
  // Before the not-found check. A quarantined issue is present but hidden, and
  // answering 404 would send the person hunting for a deletion that never
  // happened instead of at the file that needs repairing.
  refuseIfQuarantined(board, key);
  const found = findIssue(board, key);

  if (found === null || !("issue" in found)) {
    throw new IssueError("E_UNKNOWN_PROJECT", `No issue with key ${key}`);
  }
  const issue = found.issue;

  if (input.status !== undefined) {
    throw new IssueError(
      "E_STATUS_NOT_ALLOWED",
      "Status changes go through the transition endpoint, not a field update.",
    );
  }

  if (ifMatch === null) {
    throw new PreconditionRequiredError(issue.etag);
  }
  if (normaliseEtag(ifMatch) !== issue.etag) {
    throw new PreconditionFailedError(
      issue.etag,
      issue.resource as JsonValue,
      conflictsBetween(issue.resource as Record<string, JsonValue>, input),
    );
  }

  if (input.sprint !== undefined && input.sprint !== null) {
    requireOpenSprint(board, input.sprint);
  }

  if (input.parent !== undefined && input.parent !== null) {
    const type = String((issue.resource as Record<string, unknown>).type ?? "");
    refuseIfTargetQuarantined(board, input.parent);
    validateParent(board, requireKnownType(type), issue.uid, input.parent);
  }

  const absolute = path.join(board.boardRoot, issue.path);
  const original = fs.readFileSync(absolute, "utf8");
  const patched = patchIssueFile(original, input);

  if (patched === original) {
    // A no-op must not rewrite the file: it would move the ETag, add an event
    // and show up in git as a change that means nothing.
    return { issue, changed: false };
  }

  // The project's offset, matching creation. A `Z` stamp against a `+09:00`
  // created_at would compare as *earlier* on a string sort — the same
  // mixed-spelling trap the event log already avoids.
  const now = timestamp(projectTimezone(board, issue.project));
  await writable.writer.write({
    kind: "update",
    targetPath: issue.path,
    contents: touchMetadata(patched, now, actor.kind),
    expectedHash: hashOf(original),
    event: buildEvent(board.localDirectory, {
      verb: "issue.updated",
      targetKind: "issue",
      targetUid: issue.uid,
      actor,
      before: changedFields(issue.resource as Record<string, JsonValue>, input, "before"),
      after: changedFields(issue.resource as Record<string, JsonValue>, input, "after"),
      detail: { key },
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
  });

  const reread = findIssue(board, key);
  if (!reread || !("issue" in reread)) {
    throw new IssueError("E_KEY_COLLISION", `${key} could not be read back`);
  }
  return { issue: reread.issue, changed: true };
}

/**
 * Rewrites only the lines the request names.
 *
 * This edits the original text rather than re-rendering the document. A
 * re-render round-trips every value through the emitter, and that quietly
 * reformats things nobody asked to change — a timestamp gains quotes because
 * it starts with a digit, and the file "changes" without any field changing.
 * PRD §5.3 promises a hand-edited file survives untouched, and a moving ETag
 * would manufacture conflicts out of formatting.
 */
export function patchIssueFile(original: string, input: UpdateIssueInput): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/.exec(original);
  if (!match) {
    throw new IssueError("E_INVALID_TITLE", "The issue file has no frontmatter");
  }

  let lines = match[2].split("\n");

  if (input.title !== undefined) {
    lines = setScalar(lines, "title", yamlScalar(requireTitle(input.title)));
  }
  if (input.assignee !== undefined) {
    lines = input.assignee === null
      ? removeKey(lines, "assignee")
      : setScalar(lines, "assignee", yamlScalar(input.assignee));
  }
  if (input.points !== undefined) {
    const points = requirePoints(input.points);
    lines = points === null
      ? removeKey(lines, "points")
      : setScalar(lines, "points", String(points));
  }
  if (input.labels !== undefined) {
    const labels = normaliseLabels(input.labels);
    lines = labels.length === 0
      ? removeKey(lines, "labels")
      : setScalar(lines, "labels", `[${labels.map(yamlScalar).join(", ")}]`);
  }
  if (input.parent !== undefined) {
    lines = input.parent === null
      ? removeKey(lines, "parent")
      : setScalar(lines, "parent", input.parent);
  }
  if (input.sprint !== undefined) {
    lines = input.sprint === null
      ? removeKey(lines, "sprint")
      : setScalar(lines, "sprint", input.sprint);
  }
  if (input.acceptance !== undefined) {
    lines = setBlock(lines, "acceptance", renderAcceptance(normaliseAcceptance(input.acceptance)));
  }

  const body = input.description === undefined ? match[4] : ensureNewline(input.description);
  return `${match[1]}${lines.join("\n")}${match[3]}${body}`;
}

/**
 * Rewrites the `links:` block.
 *
 * Only the declaring side's file is ever touched (S1-D4): a relation written on
 * both ends doubles the merge surface and can end up half applied, with one
 * file claiming a link the other has never heard of.
 */
export function patchLinks(original: string, links: Link[]): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/.exec(original);
  if (!match) {
    throw new IssueError("E_INVALID_TITLE", "The issue file has no frontmatter");
  }

  const rendered = links.length === 0
    ? []
    : ["links:", ...links.map((link) => `  - {kind: ${link.kind}, to: ${link.to}}`)];

  const lines = setBlock(match[2].split("\n"), "links", rendered);
  return `${match[1]}${lines.join("\n")}${match[3]}${match[4]}`;
}

/**
 * Moves an issue to a new display key, keeping the old one as an alias.
 *
 * Only this file changes. `parent`, `links` and every event reference the uid,
 * which does not move — the display key is held by people's memory and by
 * commit trailers, and that is exactly what `former_keys` is for (§3.8).
 */
export function patchRekey(original: string, from: string, to: string): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/.exec(original);
  if (!match) {
    throw new IssueError("E_INVALID_TITLE", "The issue file has no frontmatter");
  }

  let lines = setScalar(match[2].split("\n"), "key", to);

  const index = indexOfKey(lines, "former_keys");
  const existing = index === -1
    ? []
    : (lines[index].slice(lines[index].indexOf(":") + 1).trim().replace(/^\[|\]$/g, "")
        .split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""));

  if (!existing.includes(from)) {
    existing.push(from);
  }
  lines = setScalar(lines, "former_keys", `[${existing.join(", ")}]`);

  return `${match[1]}${lines.join("\n")}${match[3]}${match[4]}`;
}

/** Sets one of the two rank fields, leaving the other alone (ADR-005 §1). */
export function patchRank(original: string, field: string, rank: string): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/.exec(original);
  if (!match) {
    throw new IssueError("E_INVALID_TITLE", "The issue file has no frontmatter");
  }
  // Quoted: a rank like `0|i0000f:` is not a plain scalar, and an unquoted one
  // would be read back as something else entirely.
  const lines = setScalar(match[2].split("\n"), field, `"${rank}"`);
  return `${match[1]}${lines.join("\n")}${match[3]}${match[4]}`;
}

/**
 * Stamps the fields the server owns after a change is known to be real.
 *
 * Separate from `patchIssueFile` on purpose: if this ran inside the field
 * patch, every no-op request would move `updated_at` and `rev`, the ETag would
 * follow, and a client polling with `If-Match` would see a conflict it did not
 * cause. So the caller compares the field patch against the original first and
 * only touches metadata once something actually differs.
 */
export function touchMetadata(
  original: string,
  at: string,
  actorKind: Actor["kind"],
): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/.exec(original);
  if (!match) {
    throw new IssueError("E_INVALID_TITLE", "The issue file has no frontmatter");
  }

  let lines = match[2].split("\n");
  lines = setScalar(lines, "updated_at", at);
  lines = setScalar(lines, "last_actor_kind", actorKind);
  lines = setScalar(lines, "rev", String(currentRev(lines) + 1));

  return `${match[1]}${lines.join("\n")}${match[3]}${match[4]}`;
}

/** A malformed or missing counter restarts at 0; it is display-only either way. */
function currentRev(lines: string[]): number {
  const index = indexOfKey(lines, "rev");
  if (index === -1) {
    return 0;
  }
  const value = Number(lines[index].slice(lines[index].indexOf(":") + 1).trim());
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Replaces a key and the block indented beneath it with pre-rendered lines. */
function setBlock(lines: string[], key: string, block: string[]): string[] {
  const stripped = removeKey(lines, key);
  if (block.length === 0) {
    return stripped;
  }
  const anchor = indexOfKey(stripped, "created_at");
  return anchor === -1
    ? [...stripped, ...block]
    : [...stripped.slice(0, anchor), ...block, ...stripped.slice(anchor)];
}

function normaliseAcceptance(items: AcceptanceInput[]): AcceptanceInput[] {
  return items.map((item) => {
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (text === "") {
      throw new IssueError(
        "E_INVALID_TITLE",
        "Each acceptance criterion needs a non-empty text",
      );
    }
    return { text, done: item.done === true };
  });
}

/** Replaces a top-level `key: value` line, or appends one if absent. */
function setScalar(lines: string[], key: string, value: string): string[] {
  const index = indexOfKey(lines, key);
  if (index === -1) {
    // New keys go before the timestamps, where the generated layout puts them.
    const anchor = indexOfKey(lines, "created_at");
    const entry = `${key}: ${value}`;
    return anchor === -1
      ? [...lines, entry]
      : [...lines.slice(0, anchor), entry, ...lines.slice(anchor)];
  }
  const next = [...lines];
  next[index] = `${key}: ${value}`;
  return next;
}

function removeKey(lines: string[], key: string): string[] {
  const index = indexOfKey(lines, key);
  if (index === -1) {
    return lines;
  }
  // Drop the key and any block continuation indented beneath it.
  let end = index + 1;
  while (end < lines.length && /^\s/.test(lines[end])) {
    end += 1;
  }
  return [...lines.slice(0, index), ...lines.slice(end)];
}

function indexOfKey(lines: string[], key: string): number {
  return lines.findIndex((line) => new RegExp(`^${key}:(\\s|$)`).test(line));
}

function conflictsBetween(
  current: Record<string, JsonValue>,
  input: UpdateIssueInput,
): Record<string, FieldConflict> {
  const conflicts: Record<string, FieldConflict> = {};

  for (const field of UPDATABLE) {
    const requested = input[field as keyof UpdateIssueInput];
    if (requested === undefined) {
      continue;
    }
    const key = field === "description" ? "body" : field;
    const currentValue = (current[key] ?? null) as JsonValue;
    const requestedValue = (field === "description"
      ? ensureNewline(String(requested))
      : requested) as JsonValue;

    if (
      JSON.stringify(comparable(field, currentValue)) !==
      JSON.stringify(comparable(field, requestedValue))
    ) {
      conflicts[key] = { current: currentValue, requested: requestedValue };
    }
  }
  return conflicts;
}

/**
 * Reduces a value to the part a client controls.
 *
 * Only `acceptance` needs it: the stored criteria carry a server-assigned `id`
 * that the request never sends back, so a literal comparison would report every
 * acceptance list as conflicting with an identical one.
 */
function comparable(field: UpdatableField, value: JsonValue): JsonValue {
  if (field !== "acceptance" || !Array.isArray(value)) {
    return value;
  }
  return value.map((item) => {
    const entry = (item ?? {}) as Record<string, JsonValue>;
    return { text: entry.text ?? null, done: entry.done === true };
  });
}

/** Accepts `"abc"` and bare `abc`; weak validators are refused outright. */
function normaliseEtag(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("W/")) {
    return "";
  }
  return trimmed.replace(/^"(.*)"$/, "$1");
}

/**
 * Refuses a sprint that cannot take new work.
 *
 * A closed sprint is the record of what happened, so adding to it would edit
 * history. A sprint that does not exist at all is refused here rather than
 * written and left for the integrity pass — through the API we know, and
 * writing a reference we know is broken would be choosing to break the board
 * (§5.6 covers the same violation arriving through a file).
 */
function requireOpenSprint(board: WritableBoard["board"], id: string): void {
  const row = board.db
    .prepare("SELECT id, status FROM sprints WHERE id = ? AND state = 'OK'")
    .get(id) as { id: string; status: string | null } | undefined;

  if (!row) {
    throw new IssueError("E_UNKNOWN_SPRINT", `No sprint with id ${id} on this board.`);
  }
  if (row.status === "CLOSED") {
    throw new IssueError(
      "E_SPRINT_CLOSED",
      `${id} is closed and cannot take new issues.`,
      "Move the issue to a planned or active sprint instead.",
    );
  }
}

function requireKnownType(value: string): IssueType {
  if (!(ISSUE_TYPES as readonly string[]).includes(value)) {
    throw new IssueError("E_INVALID_TYPE", `"${value}" is not an issue type`);
  }
  return value as IssueType;
}

function requireTitle(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new IssueError("E_INVALID_TITLE", "A title is required");
  }
  return trimmed;
}

function requirePoints(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_POINTS) {
    throw new IssueError(
      "E_INVALID_POINTS",
      `points must be an integer between 0 and ${MAX_POINTS}, or null`,
    );
  }
  return value;
}

function normaliseLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  for (const label of labels) {
    const trimmed = label.trim();
    if (trimmed === "" || /[\s,]/.test(trimmed)) {
      throw new IssueError("E_INVALID_LABEL", `"${label}" is not a valid label`);
    }
    seen.add(trimmed);
  }
  return [...seen].sort();
}

function ensureNewline(value: string): string {
  return value === "" || value.endsWith("\n") ? value : `${value}\n`;
}

function hashOf(contents: string): string {
  // The same function the writer uses, so the CAS compares like with like.
  return fileHash(Buffer.from(contents, "utf8"));
}

/**
 * Adds a link to the issue that declares it.
 *
 * Idempotent by pair: re-sending the same `(kind, to)` is a no-op that returns
 * the issue unchanged (S1-D4), so a retry after a dropped response cannot end
 * up with the relation listed twice.
 */
export async function addLink(
  writable: WritableBoard,
  key: string,
  ifMatch: string | null,
  input: { kind: string; to: string },
  actor: Actor,
): Promise<UpdateResult> {
  const board = writable.board;
  refuseIfQuarantined(board, key);
  const issue = requireIssue(board, key);
  // Before validateLink, which only sees state='OK' rows and would call a
  // quarantined target "not found" — true of the query, false of the board.
  refuseIfTargetQuarantined(board, input.to);
  const link = validateLink(board, issue.uid, input.kind, input.to);

  requirePrecondition(issue, ifMatch, { link: { current: null, requested: link.id } });

  const existing = declaredLinks(issue.resource);
  if (existing.some((entry) => entry.id === link.id)) {
    return { issue, changed: false };
  }

  return applyLinks(writable, issue, [...existing, link], actor, {
    verb: "issue.updated",
    detail: { key, link: link.id, added: link.id },
  });
}

/** Removes a link. Only the file that declares it can drop it (S1-D4). */
export async function removeLink(
  writable: WritableBoard,
  key: string,
  ifMatch: string | null,
  id: string,
  actor: Actor,
): Promise<UpdateResult> {
  const board = writable.board;
  refuseIfQuarantined(board, key);
  const issue = requireIssue(board, key);

  const existing = declaredLinks(issue.resource);
  const remaining = existing.filter((entry) => entry.id !== id);
  if (remaining.length === existing.length) {
    throw new IssueError(
      "E_LINK_NOT_FOUND",
      `${key} does not declare a link ${id}.`,
      "A relation shown from the other side has to be removed on the issue that declared it.",
    );
  }

  requirePrecondition(issue, ifMatch, { link: { current: id, requested: null } });

  return applyLinks(writable, issue, remaining, actor, {
    verb: "issue.updated",
    detail: { key, link: id, removed: id },
  });
}

async function applyLinks(
  writable: WritableBoard,
  issue: IssueDetail,
  links: Link[],
  actor: Actor,
  event: { verb: "issue.updated"; detail: Record<string, JsonValue> },
): Promise<UpdateResult> {
  const board = writable.board;
  const absolute = path.join(board.boardRoot, issue.path);
  const original = fs.readFileSync(absolute, "utf8");
  const patched = patchLinks(original, links);

  if (patched === original) {
    return { issue, changed: false };
  }

  const now = timestamp(projectTimezone(board, issue.project));
  const before = declaredLinks(issue.resource).map((entry) => entry.id);

  await writable.writer.write({
    kind: "update",
    targetPath: issue.path,
    contents: touchMetadata(patched, now, actor.kind),
    expectedHash: hashOf(original),
    event: buildEvent(board.localDirectory, {
      verb: event.verb,
      targetKind: "issue",
      targetUid: issue.uid,
      actor,
      before: { links: before },
      after: { links: links.map((entry) => entry.id) },
      detail: event.detail,
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
  });

  return { issue: requireIssue(board, issue.key), changed: true };
}

export class QuarantinedError extends Error {
  readonly code = "E_ISSUE_QUARANTINED";
  readonly reason: string;
  readonly path: string;
  readonly recovery: string | null;

  constructor(key: string, record: { reason: string; path: string; detail: string | null }) {
    super(`${key} is quarantined (${record.reason}) and cannot be changed until it is repaired.`);
    this.name = "QuarantinedError";
    this.reason = record.reason;
    this.path = record.path;
    this.recovery = record.detail;
  }
}

/**
 * Refuses to change an entity the board has quarantined.
 *
 * Writing to it would build on a state nobody has vouched for, and the next
 * reconcile could quarantine the result too. Repair happens in the file — the
 * error says which file and what is wrong with it (§5.6).
 */
export function refuseIfQuarantined(board: WritableBoard["board"], key: string): void {
  const record = quarantineOf(board.db, key);
  if (record !== null) {
    throw new QuarantinedError(key, record);
  }
}

/** The same refusal for an entity named as a link target or a parent. */
export function refuseIfTargetQuarantined(
  board: WritableBoard["board"],
  uid: string,
): void {
  if (isQuarantinedUid(board.db, uid)) {
    const row = board.db
      .prepare("SELECT key FROM issues WHERE uid = ? LIMIT 1")
      .get(uid) as { key: string } | undefined;
    refuseIfQuarantined(board, row?.key ?? uid);
  }
}

function requireIssue(board: WritableBoard["board"], key: string): IssueDetail {
  const found = findIssue(board, key);
  if (found === null || !("issue" in found)) {
    throw new IssueError("E_UNKNOWN_PROJECT", `No issue with key ${key}`);
  }
  return found.issue;
}

function requirePrecondition(
  issue: IssueDetail,
  ifMatch: string | null,
  conflicts: Record<string, FieldConflict>,
): void {
  if (ifMatch === null) {
    throw new PreconditionRequiredError(issue.etag);
  }
  if (normaliseEtag(ifMatch) !== issue.etag) {
    throw new PreconditionFailedError(issue.etag, issue.resource as JsonValue, conflicts);
  }
}

// ── status transitions and deletion (r01b) ──────────────────────────────────

/** Fields the server owns; a request that names one is rejected outright. */
export const IMMUTABLE_FIELDS = [
  "uid",
  "key",
  "created_at",
  "created_by_kind",
  // Stamped by `touchMetadata`. A client that could set these could backdate a
  // change or freeze the revision counter it is also asking others to trust.
  "updated_at",
  "last_actor_kind",
  "rev",
] as const;

export class TransitionError extends Error {
  readonly code: "E_TRANSITION_NOT_ALLOWED" | "E_TRANSITION_FORBIDDEN" | "E_INVALID_STATUS";
  readonly allowed: string[];

  constructor(
    code: TransitionError["code"],
    message: string,
    allowed: string[] = [],
  ) {
    super(message);
    this.name = "TransitionError";
    this.code = code;
    this.allowed = allowed;
  }
}

export interface TransitionInput {
  to: string;
  reason?: string;
}

export async function transitionIssue(
  writable: WritableBoard,
  key: string,
  ifMatch: string | null,
  input: TransitionInput,
  actor: Actor,
  role: string,
): Promise<UpdateResult> {
  const board = writable.board;
  refuseIfQuarantined(board, key);
  const found = findIssue(board, key);
  if (found === null || !("issue" in found)) {
    throw new IssueError("E_UNKNOWN_PROJECT", `No issue with key ${key}`);
  }
  const issue = found.issue;

  if (!isStatus(input.to)) {
    throw new TransitionError(
      "E_INVALID_STATUS",
      `"${input.to}" is not a status`,
      [...STATUSES],
    );
  }

  const resource = issue.resource as Record<string, unknown>;
  const from = String(resource.status ?? "BACKLOG");
  if (!isStatus(from)) {
    throw new TransitionError("E_INVALID_STATUS", `The issue holds an unknown status "${from}"`);
  }

  const blockedFrom = (resource.blocked_from as string | null) ?? null;
  const targets = allowedTargets(from, blockedFrom);

  if (from === input.to) {
    return { issue, changed: false };
  }
  if (!targets.includes(input.to)) {
    throw new TransitionError(
      "E_TRANSITION_NOT_ALLOWED",
      `${from} → ${input.to} is not a permitted transition`,
      targets,
    );
  }
  if (requiresAdmin(from, input.to) && role !== "admin") {
    throw new TransitionError(
      "E_TRANSITION_FORBIDDEN",
      `Only an admin may move an issue from ${from} to ${input.to}`,
      targets,
    );
  }

  if (ifMatch === null) {
    throw new PreconditionRequiredError(issue.etag);
  }
  if (normaliseEtag(ifMatch) !== issue.etag) {
    throw new PreconditionFailedError(issue.etag, issue.resource as JsonValue, {
      status: { current: from, requested: input.to },
    });
  }

  const absolute = path.join(board.boardRoot, issue.path);
  const original = fs.readFileSync(absolute, "utf8");
  const patched = patchStatus(original, from, input.to);

  const now = timestamp(projectTimezone(board, issue.project));
  await writable.writer.write({
    kind: "update",
    targetPath: issue.path,
    contents: touchMetadata(patched, now, actor.kind),
    expectedHash: hashOf(original),
    event: buildEvent(board.localDirectory, {
      verb: "issue.transitioned",
      targetKind: "issue",
      targetUid: issue.uid,
      actor,
      before: { status: from },
      after: { status: input.to },
      detail: { key, reason: input.reason ?? null },
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
  });

  const reread = findIssue(board, key);
  if (!reread || !("issue" in reread)) {
    throw new IssueError("E_KEY_COLLISION", `${key} could not be read back`);
  }
  return { issue: reread.issue, changed: true };
}

/**
 * Moves the status line and maintains `blocked_from`.
 *
 * Entering BLOCKED records where the work was so it can resume there; leaving
 * BLOCKED clears the marker, because a stale one would offer a return path to
 * a status the issue no longer came from.
 */
export function patchStatus(original: string, from: Status, to: Status): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/.exec(original);
  if (!match) {
    throw new IssueError("E_INVALID_TITLE", "The issue file has no frontmatter");
  }

  let lines = setScalar(match[2].split("\n"), "status", to);
  lines = shouldRecordBlockedFrom(to)
    ? setScalar(lines, "blocked_from", from)
    : removeKey(lines, "blocked_from");

  return `${match[1]}${lines.join("\n")}${match[3]}${match[4]}`;
}

export type DeleteStrategy = "promote" | "cascade_cancel";

export class ChildrenPresentError extends Error {
  readonly code = "E_CHILDREN_PRESENT";
  readonly children: string[];
  readonly strategies: DeleteStrategy[] = ["promote", "cascade_cancel"];

  constructor(key: string, children: string[]) {
    super(`${key} still has ${children.length} child issue(s).`);
    this.name = "ChildrenPresentError";
    this.children = children;
  }
}

export async function deleteIssue(
  writable: WritableBoard,
  key: string,
  ifMatch: string | null,
  actor: Actor,
  strategy: DeleteStrategy | null = null,
): Promise<void> {
  const board = writable.board;
  refuseIfQuarantined(board, key);
  const found = findIssue(board, key);
  if (found === null || !("issue" in found)) {
    throw new IssueError("E_UNKNOWN_PROJECT", `No issue with key ${key}`);
  }
  const issue = found.issue;

  const children = childrenOf(board, issue.uid);
  if (children.length > 0) {
    if (strategy === null) {
      // Refusing by default rather than picking one: both strategies are
      // destructive in different ways, and which one is right is a judgement
      // about the work, not about the data (§5.1).
      throw new ChildrenPresentError(key, children.map((child) => child.key));
    }
    if (strategy === "promote") {
      // A subtask without a parent is a shape the create path rejects outright,
      // so producing one here would leave the index holding something the API
      // could never have made — and R11 would later quarantine it.
      const subtasks = children.filter((child) => child.type === "subtask");
      if (subtasks.length > 0) {
        throw new IssueError(
          "E_STRATEGY_IMPOSSIBLE",
          `promote would leave ${subtasks.length} subtask(s) without a parent, which §5.1 forbids.`,
          `Use strategy=cascade_cancel, or reparent first: ${subtasks
            .map((child) => child.key)
            .join(", ")}`,
        );
      }
    }
  }

  if (ifMatch === null) {
    throw new PreconditionRequiredError(issue.etag);
  }
  if (normaliseEtag(ifMatch) !== issue.etag) {
    throw new PreconditionFailedError(issue.etag, issue.resource as JsonValue, {});
  }

  const absolute = path.join(board.boardRoot, issue.path);
  const now = timestamp(projectTimezone(board, issue.project));

  // Children first. If the run stops partway the parent is still there holding
  // them, which is recoverable; doing it the other way round would orphan them
  // with nothing left pointing at what they belonged to.
  for (const child of children) {
    if (strategy === "promote") {
      await updateIssue(writable, child.key, currentEtagOf(board, child.key), { parent: null }, actor);
    } else if (strategy === "cascade_cancel" && child.status !== "CANCELLED") {
      // Admin, because §5.2 lets only an admin revive from CANCELLED and the
      // cascade must be able to make the move regardless of who asked.
      await transitionIssue(
        writable,
        child.key,
        currentEtagOf(board, child.key),
        { to: "CANCELLED", reason: `parent ${key} deleted` },
        actor,
        "admin",
      );
    }
  }

  await writable.writer.write({
    kind: "delete",
    targetPath: issue.path,
    contents: null,
    expectedHash: hashOf(fs.readFileSync(absolute, "utf8")),
    event: buildEvent(board.localDirectory, {
      verb: "issue.deleted",
      targetKind: "issue",
      targetUid: issue.uid,
      actor,
      before: { key, status: (issue.resource as Record<string, unknown>).status ?? null },
      detail: { key },
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
  });
}

/** The live ETag, so a cascade can supply its own preconditions. */
function currentEtagOf(board: WritableBoard["board"], key: string): string {
  const found = findIssue(board, key);
  if (!found || !("issue" in found)) {
    throw new IssueError("E_UNKNOWN_PROJECT", `No issue with key ${key}`);
  }
  return found.issue.etag;
}

/** The named fields only, so a diff shows what the request actually touched. */
function changedFields(
  current: Record<string, JsonValue>,
  input: UpdateIssueInput,
  side: "before" | "after",
): JsonValue {
  const out: Record<string, JsonValue> = {};
  for (const field of UPDATABLE) {
    const requested = input[field as keyof UpdateIssueInput];
    if (requested === undefined) {
      continue;
    }
    const key = field === "description" ? "body" : field;
    out[key] = side === "before" ? ((current[key] ?? null) as JsonValue) : (requested as JsonValue);
  }
  return out;
}
