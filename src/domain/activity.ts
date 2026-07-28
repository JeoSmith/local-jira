import type { BoardHandle } from "../storage/board.ts";
import type { JsonValue } from "../storage/jcs.ts";
import type { ActorKind } from "./events.ts";

/** How many entries a timeline returns unless asked otherwise. */
export const TIMELINE_PAGE = 50;

export interface ActivityEntry {
  eventId: string;
  at: string;
  verb: string;
  actor: {
    id: string | null;
    kind: ActorKind | null;
    /** The person who directed an agent, when this was delegated (§6.2). */
    initiatedBy: string | null;
    runId: string | null;
  };
  before: JsonValue | null;
  after: JsonValue | null;
  detail: Record<string, JsonValue> | null;
  /** Present only when the change arrived through git, and only as a hint. */
  sourceCommit: string | null;
}

interface Row {
  event_id: string;
  at: string;
  verb: string | null;
  actor_id: string | null;
  actor_kind: string | null;
  initiated_by: string | null;
  run_id: string | null;
  before_json: string | null;
  after_json: string | null;
  detail_json: string | null;
}

/**
 * The activity on one issue, newest first.
 *
 * Reads produce no events of their own (N7), so opening this page repeatedly
 * cannot make the page longer — which is the only reason a timeline is worth
 * trusting as a record of what happened.
 *
 * Ordered by `(at, event_id)`. Timestamps have one-second resolution and two
 * changes inside the same second are ordinary, so without the second key the
 * order would vary between clones and between rebuilds of the same index. The
 * id is a ULID, so it breaks the tie in creation order rather than arbitrarily.
 */
export function activityOf(
  board: BoardHandle,
  uid: string,
  options: { limit?: number; before?: string | null } = {},
): { entries: ActivityEntry[]; hasMore: boolean } {
  const limit = Math.min(Math.max(options.limit ?? TIMELINE_PAGE, 1), 500);
  const cursor = options.before ?? null;

  const rows = board.db
    .prepare(
      `SELECT event_id, at, verb, actor_id, actor_kind, initiated_by, run_id,
              before_json, after_json, detail_json
         FROM events
        WHERE target_uid = ?
          AND (? IS NULL OR event_id < ?)
        ORDER BY at DESC, event_id DESC
        LIMIT ?`,
    )
    .all(uid, cursor, cursor, limit + 1) as Row[];

  const hasMore = rows.length > limit;
  return {
    entries: rows.slice(0, limit).map(toEntry),
    hasMore,
  };
}

function toEntry(row: Row): ActivityEntry {
  const detail = parse(row.detail_json) as Record<string, JsonValue> | null;

  return {
    eventId: row.event_id,
    at: row.at,
    verb: row.verb ?? "unknown",
    actor: {
      id: row.actor_id,
      kind: (row.actor_kind as ActorKind | null) ?? null,
      initiatedBy: row.initiated_by,
      runId: row.run_id,
    },
    before: parse(row.before_json),
    after: parse(row.after_json),
    detail,
    // Carried through as a hint and nothing more. A git author is not an
    // authenticated actor, and promoting one would put an unverified identity
    // into a record people rely on (§5.7).
    sourceCommit:
      detail !== null && typeof detail.source_commit === "string" ? detail.source_commit : null,
  };
}

function parse(value: string | null): JsonValue | null {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return null;
  }
}

/**
 * The actor kind of the most recent change to an issue.
 *
 * Distinct from `created_by_kind`, which never moves: a card has to show who
 * touched it last, or an agent's change looks exactly like the human creation
 * it is sitting on top of (§5.1, §8).
 */
export function lastActorKinds(
  board: BoardHandle,
  uids: string[],
): Map<string, ActorKind> {
  const kinds = new Map<string, ActorKind>();
  if (uids.length === 0) {
    return kinds;
  }

  const placeholders = uids.map(() => "?").join(",");
  const rows = board.db
    .prepare(
      `SELECT target_uid, actor_kind FROM events e
        WHERE target_uid IN (${placeholders})
          AND event_id = (
            SELECT event_id FROM events
             WHERE target_uid = e.target_uid
             ORDER BY at DESC, event_id DESC LIMIT 1
          )`,
    )
    .all(...uids) as Array<{ target_uid: string; actor_kind: string | null }>;

  for (const row of rows) {
    if (row.actor_kind !== null) {
      kinds.set(row.target_uid, row.actor_kind as ActorKind);
    }
  }
  return kinds;
}
