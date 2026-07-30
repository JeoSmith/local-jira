import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const RUNTIME_FILENAME = "runtime.sqlite";

/** ADR-004 §3: a claim lives 15 minutes past its last heartbeat. */
export const LEASE_MS = 15 * 60 * 1000;

/**
 * `claims.issue_uid` is the primary key, and that is the whole mechanism.
 *
 * Two agents claiming the same issue race on one INSERT, and SQLite lets
 * exactly one win. A read followed by a write would let both pass the read
 * before either wrote — the "조회 후 상태 변경" §6.1 rules out by name, and the
 * reason a lock table beats a status field here.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  issue_uid         TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  acquired_at       INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  lease_expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_claims_run ON claims(run_id);
`;

export interface Claim {
  issueUid: string;
  ownerId: string;
  runId: string;
  acquiredAt: number;
  lastHeartbeatAt: number;
  leaseExpiresAt: number;
}

export type ClaimOutcome =
  | { outcome: "acquired"; claim: Claim }
  /** Same owner and run asking again: 200 and a fresh lease (D10, ADR-004 §2). */
  | { outcome: "renewed"; claim: Claim }
  | { outcome: "held"; by: Claim };

/**
 * Claims and leases, kept out of the board tree on purpose.
 *
 * A claim describes a process running on this machine. Shared through git it
 * would arrive in another clone already meaningless — the process is not there
 * — and outlive its owner as a ghost that blocks the issue (ADR-004 §1). So
 * this file is local, disposable, and not part of what a rebuild restores. The
 * *facts* of acquiring and releasing are events, and those are files.
 */
export class RuntimeStore {
  readonly path: string;
  #db: DatabaseSync;

  constructor(localDirectory: string) {
    fs.mkdirSync(localDirectory, { recursive: true });
    this.path = path.join(localDirectory, RUNTIME_FILENAME);
    this.#db = new DatabaseSync(this.path);
    // Before `journal_mode`, which briefly needs an exclusive lock: two
    // connections opening at once would otherwise have one fail outright rather
    // than wait its turn. ADR-002 means only one server holds this board, so in
    // production the second connection is a CLI or a test — neither of which
    // should be told the database is broken when it is merely busy.
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Takes the claim, or reports who holds it.
   *
   * Expired claims are cleared first and in the same statement sequence, so a
   * lease that ran out is recoverable by whoever asks next rather than by
   * whatever happens to sweep (AC20).
   */
  acquire(
    issueUid: string,
    ownerId: string,
    runId: string,
    now: number = Date.now(),
  ): ClaimOutcome {
    this.#db.prepare("DELETE FROM claims WHERE lease_expires_at <= ?").run(now);

    try {
      this.#db
        .prepare(
          `INSERT INTO claims(issue_uid, owner_id, run_id, acquired_at,
                              last_heartbeat_at, lease_expires_at)
           VALUES(?,?,?,?,?,?)`,
        )
        .run(issueUid, ownerId, runId, now, now, now + LEASE_MS);
      return { outcome: "acquired", claim: this.find(issueUid, now)! };
    } catch {
      const held = this.find(issueUid, now)!;
      if (held.ownerId === ownerId && held.runId === runId) {
        this.renew(runId, now);
        return { outcome: "renewed", claim: this.find(issueUid, now)! };
      }
      return { outcome: "held", by: held };
    }
  }

  find(issueUid: string, now: number = Date.now()): Claim | null {
    const row = this.#db
      .prepare("SELECT * FROM claims WHERE issue_uid = ? AND lease_expires_at > ?")
      .get(issueUid, now) as Record<string, unknown> | undefined;
    return row ? toClaim(row) : null;
  }

  findByRun(runId: string, now: number = Date.now()): Claim | null {
    const row = this.#db
      .prepare("SELECT * FROM claims WHERE run_id = ? AND lease_expires_at > ?")
      .get(runId, now) as Record<string, unknown> | undefined;
    return row ? toClaim(row) : null;
  }

  /** Every live claim, for the board to show who is on what. */
  live(now: number = Date.now()): Claim[] {
    return (
      this.#db
        .prepare("SELECT * FROM claims WHERE lease_expires_at > ? ORDER BY acquired_at")
        .all(now) as Array<Record<string, unknown>>
    ).map(toClaim);
  }

  /** A heartbeat pushes the lease out by a full window (ADR-004 §3). */
  renew(runId: string, now: number = Date.now()): boolean {
    const changed = this.#db
      .prepare(
        `UPDATE claims SET last_heartbeat_at = ?, lease_expires_at = ?
          WHERE run_id = ? AND lease_expires_at > ?`,
      )
      .run(now, now + LEASE_MS, runId, now);
    return Number(changed.changes) > 0;
  }

  release(issueUid: string): boolean {
    const changed = this.#db.prepare("DELETE FROM claims WHERE issue_uid = ?").run(issueUid);
    return Number(changed.changes) > 0;
  }

  releaseRun(runId: string): boolean {
    const changed = this.#db.prepare("DELETE FROM claims WHERE run_id = ?").run(runId);
    return Number(changed.changes) > 0;
  }

  /**
   * Drops claims whose lease has run out.
   *
   * Called at startup: §5.4 says a restart reclaims expired claims in full,
   * while ones still inside their window survive — a server restarting must not
   * cost a working agent its place.
   */
  reclaimExpired(now: number = Date.now()): number {
    const removed = this.#db.prepare("DELETE FROM claims WHERE lease_expires_at <= ?").run(now);
    return Number(removed.changes);
  }
}

function toClaim(row: Record<string, unknown>): Claim {
  return {
    issueUid: String(row.issue_uid),
    ownerId: String(row.owner_id),
    runId: String(row.run_id),
    acquiredAt: Number(row.acquired_at),
    lastHeartbeatAt: Number(row.last_heartbeat_at),
    leaseExpiresAt: Number(row.lease_expires_at),
  };
}
