import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

import { classify } from "./layout.ts";
import {
  DELETE_GRACE_MS,
  loadScannedFile,
  retirePath,
  reviveMoved,
  scanBoard,
  LOAD_ORDER,
  type ReindexStats,
} from "./reindex.ts";
import { validateBoard, type IntegrityReport } from "./integrity.ts";
import { fileHash } from "./resource.ts";

/** Why a reconciliation ran. Every run logs one of these (r08c). */
export type ReconcileReason = "git_head_change" | "watcher_overflow" | "startup" | "manual";

export { DELETE_GRACE_MS } from "./reindex.ts";

export interface Tombstoned {
  path: string;
  uid: string;
  key: string | null;
}

export interface Renamed {
  from: string;
  to: string;
  uid: string;
  key: string | null;
}

export interface ReconcileReport {
  reason: ReconcileReason;
  scanned: number;
  hashed: number;
  /** Board paths whose content is new or different. */
  changed: string[];
  tombstoned: Tombstoned[];
  renamed: Renamed[];
  /** Tombstones whose grace ran out during this run — now real deletions. */
  confirmed: Tombstoned[];
  failed: number;
  durationMs: number;
  /** What stage B made of the board once everything was loaded. */
  integrity?: IntegrityReport;
}

interface KnownFile {
  path: string;
  uid: string | null;
  file_hash: string;
}

/**
 * Reconciles the whole board against the index.
 *
 * Unlike the incremental pass this re-hashes **every** file rather than
 * trusting `(mtime, size)`. After a `git checkout` those stat fields are not
 * evidence of anything: git writes whatever the commit says, and a file can
 * come back byte-identical with a new mtime or, worse, differ while keeping the
 * size. The incremental shortcut is safe for edits a person makes and unsafe
 * for a tree someone else's history just replaced.
 *
 * It is idempotent: interrupted halfway and started again from scratch, the
 * final index is the one an uninterrupted run would have produced. Nothing here
 * writes to the working tree.
 */
export function fullReconcile(
  boardRoot: string,
  db: DatabaseSync,
  options: { reason: ReconcileReason; graceMs?: number; now?: number },
): ReconcileReport {
  const started = Date.now();
  const now = options.now ?? started;
  const graceMs = options.graceMs ?? DELETE_GRACE_MS;

  const files = scanBoard(boardRoot);
  const report: ReconcileReport = {
    reason: options.reason,
    scanned: files.length,
    hashed: 0,
    changed: [],
    tombstoned: [],
    renamed: [],
    confirmed: [],
    failed: 0,
    durationMs: 0,
  };

  const known = new Map<string, KnownFile>();
  for (const row of db
    .prepare("SELECT path, uid, file_hash FROM file_state")
    .all() as KnownFile[]) {
    known.set(row.path, row);
  }

  const stats: ReindexStats = {
    scanned: files.length, parsed: 0, hashed: 0, removed: 0, failed: 0, durationMs: 0,
  };

  db.exec("BEGIN");
  try {
    const seen = new Set<string>();

    // 1. Everything on disk, hashed.
    for (const kind of LOAD_ORDER) {
      for (const file of files) {
        if (file.identity.kind !== kind) {
          continue;
        }
        seen.add(file.identity.path);

        const bytes = fs.readFileSync(file.absolutePath);
        const hash = fileHash(bytes);
        report.hashed += 1;

        const previous = known.get(file.identity.path);
        if (previous && previous.file_hash === hash) {
          db.prepare("UPDATE file_state SET mtime_ms = ?, size = ? WHERE path = ?")
            .run(file.mtimeMs, file.size, file.identity.path);
          continue;
        }

        loadScannedFile(db, file, bytes, hash, stats);
        report.changed.push(file.identity.path);
      }
    }
    report.failed = stats.failed;

    // 2. Files the index knows and the disk no longer has. `retirePath` owns
    //    what that means, so this pass and the incremental one cannot drift.
    for (const [knownPath, entry] of known) {
      if (seen.has(knownPath)) {
        continue;
      }
      const identity = classify(knownPath);
      if (!identity) {
        db.prepare("DELETE FROM file_state WHERE path = ?").run(knownPath);
        continue;
      }

      const retired = retirePath(db, knownPath, identity, { now, graceMs });
      if (retired.outcome === "moved" && retired.uid && retired.to) {
        report.renamed.push({
          from: retired.path,
          to: retired.to,
          uid: retired.uid,
          key: retired.key,
        });
      } else if (retired.outcome === "tombstoned" && retired.uid) {
        report.tombstoned.push({ path: retired.path, uid: retired.uid, key: retired.key });
      }
    }

    // 3. A file that came back within grace cancels its own tombstone.
    for (const relative of report.changed) {
      for (const revived of reviveMoved(db, relative, now)) {
        report.renamed.push({
          from: revived.from,
          to: relative,
          uid: revived.uid,
          key: revived.key,
        });
        report.tombstoned = report.tombstoned.filter((entry) => entry.path !== revived.from);
      }
    }

    // 4. Grace that ran out. The row stays; only the deadline is cleared, which
    //    is what distinguishes "still might come back" from "it is gone".
    const expired = db
      .prepare(
        `SELECT path, uid, key FROM issues
          WHERE state = 'PENDING_DELETE'
            AND delete_deadline_at IS NOT NULL AND delete_deadline_at <= ?`,
      )
      .all(now) as Tombstoned[];

    for (const entry of expired) {
      db.prepare("UPDATE issues SET delete_deadline_at = NULL WHERE path = ?").run(entry.path);
      report.confirmed.push(entry);
    }

    // 5. Stage B, once the set is whole. A pull is the most likely way to get a
    //    dangling reference or a duplicate uid in the first place.
    report.integrity = validateBoard(db, now);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  report.durationMs = Date.now() - started;
  return report;
}

/** A tombstoned issue, for a 404 that can still say where the file used to be. */
export function findTombstone(
  db: DatabaseSync,
  key: string,
): { key: string; uid: string; path: string; pending: boolean } | null {
  const row = db
    .prepare(
      `SELECT key, uid, path, delete_deadline_at FROM issues
        WHERE key = ? AND state = 'PENDING_DELETE'
        ORDER BY delete_deadline_at IS NULL, path LIMIT 1`,
    )
    .get(key) as
    | { key: string; uid: string; path: string; delete_deadline_at: number | null }
    | undefined;

  return row
    ? { key: row.key, uid: row.uid, path: row.path, pending: row.delete_deadline_at !== null }
    : null;
}
