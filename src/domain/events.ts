import fs from "node:fs";
import path from "node:path";

import { createUlid } from "../bootstrap/identifier.ts";
import { canonicalJson, type JsonValue } from "../storage/jcs.ts";

export const ACTOR_KINDS = ["human", "agent", "external", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Verbs in the N7 audit scope. Reads and searches are deliberately absent. */
export const VERBS = [
  "issue.created",
  "issue.updated",
  "issue.transitioned",
  "issue.deleted",
  "issue.changed_externally",
  "issue.rekeyed",
  "comment.added",
  "comment.resolved",
  "claim.acquired",
  "claim.released",
  "claim.reclaimed",
  "run.started",
  "run.ended",
  "sprint.created",
  "sprint.updated",
  "sprint.started",
  "sprint.closed",
  "sprint.deleted",
  "user.created",
  "user.role_changed",
  "token.issued",
  "token.revoked",
  "access.denied",
] as const;
export type Verb = (typeof VERBS)[number];

export interface EventActor {
  id: string | null;
  kind: ActorKind;
  /** The person who directed an agent, when this was delegated (§6.2). */
  initiatedBy?: string | null;
  runId?: string | null;
  /** The PAT that made the request, when one did. Never the token itself (N6). */
  tokenId?: string | null;
}

export interface EventInput {
  verb: Verb;
  targetKind: "issue" | "sprint" | "user" | "comment" | "run" | "board";
  targetUid: string | null;
  actor: EventActor;
  /** Values before and after, already stripped of anything secret. */
  before?: JsonValue;
  after?: JsonValue;
  detail?: Record<string, JsonValue>;
  at?: string;
}

export interface BuiltEvent {
  eventId: string;
  path: string;
  line: string;
}

/**
 * Builds one audit record.
 *
 * Every event goes through here so the shape cannot drift between call sites —
 * a timeline that sometimes has `before` and sometimes does not is a timeline
 * nobody can query.
 *
 * The file is per day *and per node*, so two clones appending on the same day
 * write to different files and never meet in a merge (PRD §5.3).
 */
export function buildEvent(localDirectory: string, input: EventInput): BuiltEvent {
  const eventId = createUlid();
  const at = toUtc(input.at);

  const record: Record<string, JsonValue> = {
    event_id: eventId,
    at,
    actor_id: input.actor.id,
    actor_kind: input.actor.kind,
    run_id: input.actor.runId ?? null,
    initiated_by: input.actor.initiatedBy ?? null,
    // AC16 wants successes and refusals alike traceable to the token that made
    // them, which a user id cannot do: one account may hold several tokens, and
    // revoking the right one means knowing which was used.
    token_id: input.actor.tokenId ?? null,
    target_kind: input.targetKind,
    target_uid: input.targetUid,
    verb: input.verb,
    before: input.before ?? null,
    after: input.after ?? null,
  };
  if (input.detail !== undefined) {
    record.detail = input.detail;
  }

  return {
    eventId,
    path: `events/${at.slice(0, 10)}/${nodeId(localDirectory)}.jsonl`,
    // Canonical JSON so a record is byte-identical wherever it is rebuilt.
    line: canonicalJson(record),
  };
}

/**
 * Names that survive the filter below because they are identifiers, not secrets.
 *
 * A list of exact keys rather than a looser pattern: `token_id` names a token
 * without revealing anything usable, and r13a AC9 requires an audit record to
 * identify the token that way. Widening the rule to "anything ending in _id"
 * would let a future `credential_id` through without anyone deciding to.
 */
const ALLOWED = new Set(["token_id"]);

/**
 * Removes anything that must never reach an audit record (N6).
 *
 * Applied at the boundary rather than trusted to each caller: an event is
 * written to a file that gets committed and pushed, so a leaked hash there is
 * a leak to everyone with the repository.
 */
export function redact(value: Record<string, unknown>): JsonValue {
  const out: Record<string, JsonValue> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (SECRET.test(key) && !ALLOWED.has(key)) {
      continue;
    }
    out[key] = scrub(entry);
  }
  return out;
}

const SECRET = /password|hash|token|salt|secret|credential/i;

/**
 * One value, whatever shape it is.
 *
 * Arrays are their own case because `typeof [] === "object"`: recursing into
 * one through `Object.entries` turns `["a","b"]` into `{"0":"a","1":"b"}`, and
 * an audit record that changes the shape of what it recorded is not a record
 * of it. Elements are still scrubbed — a list of objects can hold a secret.
 */
function scrub(entry: unknown): JsonValue {
  if (entry === null || entry === undefined) {
    return null;
  }
  if (Array.isArray(entry)) {
    return entry.map(scrub) as JsonValue;
  }
  if (typeof entry === "object") {
    return redact(entry as Record<string, unknown>);
  }
  return entry as JsonValue;
}

/**
 * Normalises the timestamp to UTC.
 *
 * Issue files carry the project's offset so a local day boundary reads
 * correctly, but an event log is a chronological record that gets sorted as a
 * string. Mixing `+09:00` and `Z` records makes that sort wrong even though
 * both spellings are valid RFC 3339 — the day directory would disagree with
 * the ordering inside it.
 */
function toUtc(at: string | undefined): string {
  const instant = at === undefined ? new Date() : new Date(at);
  if (Number.isNaN(instant.getTime())) {
    return `${new Date().toISOString().slice(0, 19)}Z`;
  }
  return `${instant.toISOString().slice(0, 19)}Z`;
}

export function nodeId(localDirectory: string): string {
  try {
    const contents = fs.readFileSync(path.join(localDirectory, "node.yaml"), "utf8");
    return /^node_id:\s*(\S+)$/m.exec(contents)?.[1] ?? "unknown";
  } catch {
    // A board that predates node identity still has to be writable.
    return "unknown";
  }
}
