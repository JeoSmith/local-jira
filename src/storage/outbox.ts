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

export type OpKind = "create" | "update" | "delete";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id          TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('create','update','delete')),
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
