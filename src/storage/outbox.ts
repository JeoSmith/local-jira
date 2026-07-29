import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

import { createUlid } from "../bootstrap/identifier.ts";

export const OUTBOX_FILENAME = "outbox.sqlite";

/** Durable markers for how far a write got (design §3.4). */
export const STAGES = [
  "PENDING",
  "FILE_DONE",
  "INDEX_DONE",
  "EVENT_DONE",
  "DONE",
  "ABORTED",
] as const;
export type Stage = (typeof STAGES)[number];

/** `event` records an event with no file write — used for external changes. */
export type OpKind = "create" | "update" | "delete" | "event";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id          TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('create','update','delete','event')),
  stage          TEXT NOT NULL CHECK (stage IN
                   ('PENDING','FILE_DONE','INDEX_DONE','EVENT_DONE','DONE','ABORTED')),
  target_path    TEXT NOT NULL,
  before_hash    TEXT,
  result_hash    TEXT,
  payload        BLOB,
  event_path     TEXT,
  event_id       TEXT,
  event_payload  TEXT,
  actor_id       TEXT,
  actor_kind     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  aborted_reason TEXT
);
CREATE INDEX IF NOT EXISTS ix_outbox_replay ON outbox(seq)
  WHERE stage NOT IN ('DONE','ABORTED');
CREATE TABLE IF NOT EXISTS idempotency (
  actor_id     TEXT NOT NULL,
  key          TEXT NOT NULL,
  -- Canonical JSON hash of the request. Two requests that differ are two
  -- requests however they spell their whitespace (S3-D4).
  request_hash TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('IN_PROGRESS','DONE')),
  status       INTEGER,
  body         TEXT,
  etag         TEXT,
  -- Written when the write journal accepts the operation, so it survives a
  -- crash that happens before the response is known.
  target_path  TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (actor_id, key)
);
`;

export interface OutboxOp {
  kind: OpKind;
  targetPath: string;
  /** file_hash before the write; null when creating. */
  beforeHash: string | null;
  /** file_hash the write should produce; null when deleting. */
  resultHash: string | null;
  /** Final bytes, so a replay can roll forward without recomputing them. */
  payload: Buffer | null;
  eventPath: string | null;
  eventId: string | null;
  eventPayload: string | null;
  actorId: string | null;
  actorKind: string;
}

export interface OutboxRecord extends OutboxOp {
  seq: number;
  opId: string;
  stage: Stage;
}

/**
 * The write-ahead record for a domain write.
 *
 * Files, index and event log are three stores that cannot be committed
 * together, so the outbox makes the intent durable first and every later step
 * idempotent. `synchronous = FULL` because losing this record is the one
 * failure the design cannot recover from.
 */
/** PRD §5.4: a key protects a request for 24 hours, restart or not. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyRecord {
  actorId: string;
  key: string;
  requestHash: string;
  state: "IN_PROGRESS" | "DONE";
  status: number | null;
  body: string | null;
  etag: string | null;
  targetPath: string | null;
  createdAt: number;
}

export type IdempotencyClaim =
  | { outcome: "claimed" }
  /** Same key, different request. Not a retry — a bug, and 409 says so (S3-D4). */
  | { outcome: "mismatch"; held: IdempotencyRecord }
  | { outcome: "in_progress"; held: IdempotencyRecord }
  | { outcome: "replay"; held: IdempotencyRecord };

export class Outbox {
  readonly path: string;
  #db: DatabaseSync;

  constructor(localDirectory: string) {
    fs.mkdirSync(localDirectory, { recursive: true });
    this.path = path.join(localDirectory, OUTBOX_FILENAME);
    this.#db = new DatabaseSync(this.path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = FULL");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  begin(op: OutboxOp): OutboxRecord {
    const opId = createUlid();
    this.#db
      .prepare(
        `INSERT INTO outbox(op_id, kind, stage, target_path, before_hash, result_hash,
           payload, event_path, event_id, event_payload, actor_id, actor_kind, created_at)
         VALUES(?,?,'PENDING',?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        opId, op.kind, op.targetPath, op.beforeHash, op.resultHash,
        op.payload, op.eventPath, op.eventId, op.eventPayload,
        op.actorId, op.actorKind, Date.now(),
      );

    const seq = Number(
      (this.#db.prepare("SELECT seq FROM outbox WHERE op_id = ?").get(opId) as { seq: number }).seq,
    );
    return { ...op, seq, opId, stage: "PENDING" };
  }

  advance(seq: number, stage: Stage): void {
    this.#db.prepare("UPDATE outbox SET stage = ? WHERE seq = ?").run(stage, seq);
  }

  abort(seq: number, reason: string): void {
    this.#db
      .prepare("UPDATE outbox SET stage = 'ABORTED', aborted_reason = ? WHERE seq = ?")
      .run(reason, seq);
  }

  /** Unfinished writes in the order they were started. */
  pending(): OutboxRecord[] {
    return (
      this.#db
        .prepare(
          `SELECT seq, op_id, kind, stage, target_path, before_hash, result_hash, payload,
                  event_path, event_id, event_payload, actor_id, actor_kind
             FROM outbox WHERE stage NOT IN ('DONE','ABORTED') ORDER BY seq`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      seq: Number(row.seq),
      opId: String(row.op_id),
      kind: row.kind as OpKind,
      stage: row.stage as Stage,
      targetPath: String(row.target_path),
      beforeHash: (row.before_hash as string | null) ?? null,
      resultHash: (row.result_hash as string | null) ?? null,
      payload: row.payload === null ? null : Buffer.from(row.payload as Uint8Array),
      eventPath: (row.event_path as string | null) ?? null,
      eventId: (row.event_id as string | null) ?? null,
      eventPayload: (row.event_payload as string | null) ?? null,
      actorId: (row.actor_id as string | null) ?? null,
      actorKind: String(row.actor_kind),
    }));
  }

  // ── idempotency (PRD §5.4) ────────────────────────────────────────────────

  /**
   * Claims `(actor, key)` for this request, or reports who already holds it.
   *
   * A single INSERT rather than a read followed by a write: two requests
   * arriving with the same key must not both find it free, and the primary key
   * is what decides that in one step.
   */
  reserveIdempotency(
    actorId: string,
    key: string,
    requestHash: string,
    now: number = Date.now(),
  ): IdempotencyClaim {
    // Past the window the key is no longer protected, so an old record must
    // not stand in the way of a new request reusing the string (AC9).
    this.#db
      .prepare("DELETE FROM idempotency WHERE actor_id = ? AND key = ? AND created_at <= ?")
      .run(actorId, key, now - IDEMPOTENCY_TTL_MS);

    try {
      this.#db
        .prepare(
          `INSERT INTO idempotency(actor_id, key, request_hash, state, created_at)
           VALUES(?,?,?,'IN_PROGRESS',?)`,
        )
        .run(actorId, key, requestHash, now);
      return { outcome: "claimed" };
    } catch {
      const held = this.findIdempotency(actorId, key)!;
      if (held.requestHash !== requestHash) {
        return { outcome: "mismatch", held };
      }
      return held.state === "DONE"
        ? { outcome: "replay", held }
        : { outcome: "in_progress", held };
    }
  }

  findIdempotency(actorId: string, key: string): IdempotencyRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM idempotency WHERE actor_id = ? AND key = ?")
      .get(actorId, key) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      actorId: String(row.actor_id),
      key: String(row.key),
      requestHash: String(row.request_hash),
      state: row.state as "IN_PROGRESS" | "DONE",
      status: row.status === null ? null : Number(row.status),
      body: (row.body as string | null) ?? null,
      etag: (row.etag as string | null) ?? null,
      targetPath: (row.target_path as string | null) ?? null,
      createdAt: Number(row.created_at),
    };
  }

  /**
   * Records what the write touched, from inside the write path.
   *
   * The response is not known yet — a create reads its result back afterwards —
   * so this stores the one thing that is known and durable. A crash between
   * here and the response leaves a record that still says which resource the
   * key produced, which is what keeps a retry from making a second one (AC10).
   */
  noteIdempotencyTarget(actorId: string, key: string, targetPath: string): void {
    this.#db
      .prepare(
        "UPDATE idempotency SET target_path = ? WHERE actor_id = ? AND key = ? AND state = 'IN_PROGRESS'",
      )
      .run(targetPath, actorId, key);
  }

  completeIdempotency(
    actorId: string,
    key: string,
    response: { status: number; body: string; etag: string | null },
  ): void {
    this.#db
      .prepare(
        `UPDATE idempotency SET state = 'DONE', status = ?, body = ?, etag = ?
          WHERE actor_id = ? AND key = ?`,
      )
      .run(response.status, response.body, response.etag, actorId, key);
  }

  /** Gives the key back when the request failed, so a retry may try again. */
  releaseIdempotency(actorId: string, key: string): void {
    this.#db
      .prepare("DELETE FROM idempotency WHERE actor_id = ? AND key = ? AND state = 'IN_PROGRESS'")
      .run(actorId, key);
  }

  /**
   * Settles reservations left unfinished by a crash.
   *
   * One with no `target_path` never reached the write journal, so nothing
   * happened and the key is free again. One that did reach it produced a
   * resource, and the replay is about to finish writing that resource — the
   * record has to survive so the retry is answered from it instead of creating
   * a second one.
   */
  resolveOrphanedIdempotency(): { released: number; kept: number } {
    // Settled rather than left IN_PROGRESS: nothing is processing it any more,
    // so answering a retry with "still working on it" would never come true.
    // It carries no body, and `target_path` is what the replay reads instead.
    const kept = this.#db
      .prepare(
        "UPDATE idempotency SET state = 'DONE' WHERE state = 'IN_PROGRESS' AND target_path IS NOT NULL",
      )
      .run();
    const released = this.#db
      .prepare("DELETE FROM idempotency WHERE state = 'IN_PROGRESS' AND target_path IS NULL")
      .run();
    return { released: Number(released.changes), kept: Number(kept.changes) };
  }

  purgeIdempotency(now: number = Date.now()): number {
    const removed = this.#db
      .prepare("DELETE FROM idempotency WHERE created_at <= ?")
      .run(now - IDEMPOTENCY_TTL_MS);
    return Number(removed.changes);
  }

  /** Records older than the retention window, once they are settled. */
  prune(olderThanMs: number, now: number = Date.now()): number {
    const before = this.count();
    this.#db
      .prepare("DELETE FROM outbox WHERE stage IN ('DONE','ABORTED') AND created_at < ?")
      .run(now - olderThanMs);
    return before - this.count();
  }

  count(): number {
    return Number(
      (this.#db.prepare("SELECT COUNT(*) c FROM outbox").get() as { c: number }).c,
    );
  }

  stageOf(seq: number): Stage | null {
    const row = this.#db.prepare("SELECT stage FROM outbox WHERE seq = ?").get(seq) as
      | { stage?: string }
      | undefined;
    return (row?.stage as Stage | undefined) ?? null;
  }
}
