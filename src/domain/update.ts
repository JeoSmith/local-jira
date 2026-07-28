import fs from "node:fs";
import path from "node:path";

import { createUlid } from "../bootstrap/identifier.ts";
import { yamlScalar } from "../bootstrap/scaffold.ts";
import type { JsonValue } from "../storage/jcs.ts";
import { findIssue, type IssueDetail, type WritableBoard } from "../storage/board.ts";
import { fileHash, parseMarkdownResource } from "../storage/resource.ts";
import { IssueError, MAX_POINTS, type Actor } from "./issue.ts";
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
  "description",
] as const;
export type UpdatableField = (typeof UPDATABLE)[number];

export interface UpdateIssueInput {
  title?: string;
  points?: number | null;
  labels?: string[];
  assignee?: string | null;
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

  const absolute = path.join(board.boardRoot, issue.path);
  const original = fs.readFileSync(absolute, "utf8");
  const patched = patchIssueFile(original, input);

  if (patched === original) {
    // A no-op must not rewrite the file: it would move the ETag, add an event
    // and show up in git as a change that means nothing.
    return { issue, changed: false };
  }

  const now = new Date().toISOString().slice(0, 19) + "Z";
  await writable.writer.write({
    kind: "update",
    targetPath: issue.path,
    contents: patched,
    expectedHash: hashOf(original),
    event: buildUpdateEvent(board.localDirectory, issue.uid, key, actor, now, input),
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

  const body = input.description === undefined ? match[4] : ensureNewline(input.description);
  return `${match[1]}${lines.join("\n")}${match[3]}${body}`;
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

    if (JSON.stringify(currentValue) !== JSON.stringify(requestedValue)) {
      conflicts[key] = { current: currentValue, requested: requestedValue };
    }
  }
  return conflicts;
}

/** Accepts `"abc"` and bare `abc`; weak validators are refused outright. */
function normaliseEtag(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("W/")) {
    return "";
  }
  return trimmed.replace(/^"(.*)"$/, "$1");
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

function buildUpdateEvent(
  localDirectory: string,
  uid: string,
  key: string,
  actor: Actor,
  at: string,
  input: UpdateIssueInput,
): { eventId: string; path: string; line: string } {
  const eventId = createUlid();
  return {
    eventId,
    path: `events/${at.slice(0, 10)}/${nodeId(localDirectory)}.jsonl`,
    line: JSON.stringify({
      event_id: eventId,
      at,
      actor_id: actor.id,
      actor_kind: actor.kind,
      target_kind: "issue",
      target_uid: uid,
      verb: "issue.updated",
      detail: { key, fields: Object.keys(input).filter((field) => field !== "status") },
    }),
  };
}

function nodeId(localDirectory: string): string {
  try {
    const contents = fs.readFileSync(path.join(localDirectory, "node.yaml"), "utf8");
    return /^node_id:\s*(\S+)$/m.exec(contents)?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function ensureNewline(value: string): string {
  return value === "" || value.endsWith("\n") ? value : `${value}\n`;
}

function hashOf(contents: string): string {
  // The same function the writer uses, so the CAS compares like with like.
  return fileHash(Buffer.from(contents, "utf8"));
}

// ── status transitions and deletion (r01b) ──────────────────────────────────

/** Fields the server owns; a request that names one is rejected outright. */
export const IMMUTABLE_FIELDS = ["uid", "key", "created_at", "created_by_kind"] as const;

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

  const now = new Date().toISOString().slice(0, 19) + "Z";
  await writable.writer.write({
    kind: "update",
    targetPath: issue.path,
    contents: patched,
    expectedHash: hashOf(original),
    event: buildTransitionEvent(board.localDirectory, issue.uid, key, actor, now, from, input),
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

export async function deleteIssue(
  writable: WritableBoard,
  key: string,
  ifMatch: string | null,
  actor: Actor,
): Promise<void> {
  const board = writable.board;
  const found = findIssue(board, key);
  if (found === null || !("issue" in found)) {
    throw new IssueError("E_UNKNOWN_PROJECT", `No issue with key ${key}`);
  }
  const issue = found.issue;

  const children = board.db
    .prepare("SELECT key FROM issues WHERE parent_uid = ? AND state='OK'")
    .all(issue.uid) as Array<{ key: string }>;
  if (children.length > 0) {
    // r02a owns promote/cascade_cancel; refusing here keeps a parent from
    // being removed while its children still point at it.
    throw new IssueError(
      "E_KEY_COLLISION",
      `${key} still has ${children.length} child issue(s)`,
      `Reparent or cancel them first: ${children.map((child) => child.key).join(", ")}`,
    );
  }

  if (ifMatch === null) {
    throw new PreconditionRequiredError(issue.etag);
  }
  if (normaliseEtag(ifMatch) !== issue.etag) {
    throw new PreconditionFailedError(issue.etag, issue.resource as JsonValue, {});
  }

  const absolute = path.join(board.boardRoot, issue.path);
  const now = new Date().toISOString().slice(0, 19) + "Z";

  await writable.writer.write({
    kind: "delete",
    targetPath: issue.path,
    contents: null,
    expectedHash: hashOf(fs.readFileSync(absolute, "utf8")),
    event: buildDeleteEvent(board.localDirectory, issue.uid, key, actor, now),
    actorId: actor.id,
    actorKind: actor.kind,
  });
}

function buildTransitionEvent(
  localDirectory: string,
  uid: string,
  key: string,
  actor: Actor,
  at: string,
  from: Status,
  input: TransitionInput,
): { eventId: string; path: string; line: string } {
  const eventId = createUlid();
  return {
    eventId,
    path: `events/${at.slice(0, 10)}/${nodeId(localDirectory)}.jsonl`,
    line: JSON.stringify({
      event_id: eventId,
      at,
      actor_id: actor.id,
      actor_kind: actor.kind,
      target_kind: "issue",
      target_uid: uid,
      verb: "issue.transitioned",
      detail: { key, from, to: input.to, reason: input.reason ?? null },
    }),
  };
}

function buildDeleteEvent(
  localDirectory: string,
  uid: string,
  key: string,
  actor: Actor,
  at: string,
): { eventId: string; path: string; line: string } {
  const eventId = createUlid();
  return {
    eventId,
    path: `events/${at.slice(0, 10)}/${nodeId(localDirectory)}.jsonl`,
    line: JSON.stringify({
      event_id: eventId,
      at,
      actor_id: actor.id,
      actor_kind: actor.kind,
      target_kind: "issue",
      target_uid: uid,
      verb: "issue.deleted",
      detail: { key },
    }),
  };
}
