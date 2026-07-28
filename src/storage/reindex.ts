import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

import {
  createIndex,
  getMeta,
  INDEX_BUILD_FILENAME,
  promoteIndex,
  setMeta,
} from "./index-db.ts";
import { classify, isExcluded, toBoardPath, type FileIdentity } from "./layout.ts";
import { buildRecords, isParseError } from "./records.ts";
import { fileHash } from "./resource.ts";

export interface ScannedFile {
  identity: FileIdentity;
  absolutePath: string;
  mtimeMs: number;
  size: number;
}

export interface ReindexStats {
  scanned: number;
  parsed: number;
  hashed: number;
  removed: number;
  failed: number;
  durationMs: number;
  /** Board-relative paths whose content actually changed. */
  changed?: string[];
}

/** Ordered so that a comment's body row exists before its ops are replayed. */
export const LOAD_ORDER: FileIdentity["kind"][] = [
  "config",
  "users",
  "project",
  "sprint",
  "issue",
  "comment",
  "comment_ops",
  "run",
  "proposal",
  "event",
];

/**
 * How long a vanished file may still turn out to be a move.
 *
 * A rename reaches the watcher as a delete and a create with nothing linking
 * them, and on a `git checkout` the two can be seconds apart. Deleting the
 * entity on sight would drop its links and history and then recreate it as a
 * stranger (PRD §5.5).
 */
export const DELETE_GRACE_MS = 60_000;

export interface RetireOptions {
  now: number;
  graceMs: number;
}

export interface Retired {
  outcome: "moved" | "tombstoned" | "cleared";
  path: string;
  uid: string | null;
  key: string | null;
  to: string | null;
}

/**
 * Retires the index rows for a file that is no longer on disk.
 *
 * The one place that decides what a vanished file means, so the incremental
 * pass and the full pass cannot disagree. They used to: the incremental pass
 * deleted the row outright, which meant whether a deletion kept its history
 * depended on which trigger happened to notice it first.
 *
 * An issue whose uid is live at another path has moved, not gone. Otherwise it
 * becomes a tombstone: the row survives, hidden from every query by the
 * `state='OK'` filter, until the grace period makes the deletion credible.
 */
export function retirePath(
  db: DatabaseSync,
  knownPath: string,
  identity: FileIdentity,
  options: RetireOptions,
): Retired {
  if (identity.kind !== "issue") {
    // Nothing else carries history that outlives its file.
    clearFile(db, identity);
    db.prepare("DELETE FROM file_state WHERE path = ?").run(knownPath);
    return { outcome: "cleared", path: knownPath, uid: null, key: null, to: null };
  }

  const issue = db
    .prepare("SELECT uid, key FROM issues WHERE path = ?")
    .get(knownPath) as { uid: string; key: string | null } | undefined;

  const moved = issue
    ? (db
        .prepare("SELECT path FROM issues WHERE uid = ? AND path != ? AND state = 'OK'")
        .get(issue.uid, knownPath) as { path: string } | undefined)
    : undefined;

  if (!issue || moved) {
    clearFile(db, identity);
    db.prepare("DELETE FROM file_state WHERE path = ?").run(knownPath);
    return {
      outcome: moved ? "moved" : "cleared",
      path: knownPath,
      uid: issue?.uid ?? null,
      key: issue?.key ?? null,
      to: moved?.path ?? null,
    };
  }

  db.prepare(
    `UPDATE issues SET state = 'PENDING_DELETE', delete_deadline_at = ?
      WHERE path = ? AND state != 'PENDING_DELETE'`,
  ).run(options.now + options.graceMs, knownPath);
  db.prepare("DELETE FROM issues_fts WHERE uid = ?").run(issue.uid);
  db.prepare("DELETE FROM file_state WHERE path = ?").run(knownPath);

  return { outcome: "tombstoned", path: knownPath, uid: issue.uid, key: issue.key, to: null };
}

/**
 * Cancels tombstones for a uid that has just reappeared at `relative`.
 *
 * Only inside the grace period: past it the deletion has been announced, and
 * un-announcing it would be a worse lie than a late one.
 */
export function reviveMoved(
  db: DatabaseSync,
  relative: string,
  now: number,
): Array<{ from: string; key: string | null; uid: string }> {
  const row = db
    .prepare("SELECT uid FROM issues WHERE path = ? AND state = 'OK'")
    .get(relative) as { uid: string } | undefined;
  if (!row) {
    return [];
  }

  const stale = db
    .prepare(
      `SELECT path, key FROM issues
        WHERE uid = ? AND path != ? AND state = 'PENDING_DELETE'
          AND delete_deadline_at IS NOT NULL AND delete_deadline_at > ?`,
    )
    .all(row.uid, relative, now) as Array<{ path: string; key: string | null }>;

  for (const entry of stale) {
    db.prepare("DELETE FROM issues WHERE path = ?").run(entry.path);
  }
  return stale.map((entry) => ({ from: entry.path, key: entry.key, uid: row.uid }));
}

export function scanBoard(boardRoot: string): ScannedFile[] {
  const found: ScannedFile[] = [];

  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = toBoardPath(boardRoot, absolute);
      if (isExcluded(relative)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const identity = classify(relative);
      if (!identity) {
        continue;
      }
      const stat = fs.statSync(absolute);
      found.push({
        identity,
        absolutePath: absolute,
        mtimeMs: Math.floor(stat.mtimeMs),
        size: stat.size,
      });
    }
  };

  walk(boardRoot);
  return found;
}

/**
 * Rebuilds the whole index from files.
 *
 * Built into a separate database and swapped in by rename, so readers keep
 * seeing the previous generation until the new one is complete (§3.7).
 * Domain files are only ever read here — a rebuild must leave the working tree
 * untouched, which is what makes it safe to trigger automatically.
 */
export function rebuildIndex(
  boardRoot: string,
  localDirectory: string,
  current: DatabaseSync,
): { db: DatabaseSync; stats: ReindexStats } {
  const started = Date.now();
  const buildPath = path.join(localDirectory, INDEX_BUILD_FILENAME);
  const built = createIndex(buildPath);

  const files = scanBoard(boardRoot);
  const stats: ReindexStats = {
    scanned: files.length,
    parsed: 0,
    hashed: 0,
    removed: 0,
    failed: 0,
    durationMs: 0,
  };

  built.exec("BEGIN");
  try {
    for (const kind of LOAD_ORDER) {
      for (const file of files) {
        if (file.identity.kind !== kind) {
          continue;
        }
        const bytes = fs.readFileSync(file.absolutePath);
        const hash = fileHash(bytes);
        stats.hashed += 1;

        if (loadScannedFile(built, file, bytes, hash, stats)) {
          stats.parsed += 1;
        }
      }
    }
    setMeta(built, "last_full_rebuild_at", String(Date.now()));
    built.exec("COMMIT");
  } catch (error) {
    built.exec("ROLLBACK");
    built.close();
    fs.rmSync(buildPath, { force: true });
    throw error;
  }

  current.close();
  const db = promoteIndex(localDirectory, built, buildPath);
  stats.durationMs = Date.now() - started;
  return { db, stats };
}

/**
 * Brings an existing index up to date without re-reading everything.
 *
 * `(mtime, size)` narrows the candidates and only those are hashed; a file
 * whose metadata is unchanged is not read at all. This fast path is allowed
 * here but *not* in a full reconciliation, where a same-size edit with a
 * restored mtime would otherwise stay invisible for ever (§3.5).
 */
export function incrementalSync(
  boardRoot: string,
  db: DatabaseSync,
): ReindexStats {
  const started = Date.now();
  const files = scanBoard(boardRoot);
  const stats: ReindexStats = {
    scanned: files.length,
    parsed: 0,
    hashed: 0,
    removed: 0,
    failed: 0,
    durationMs: 0,
  };

  const known = new Map<string, { mtime_ms: number; size: number; file_hash: string }>();
  for (const row of db
    .prepare("SELECT path, mtime_ms, size, file_hash FROM file_state")
    .all() as Array<{ path: string; mtime_ms: number; size: number; file_hash: string }>) {
    known.set(row.path, row);
  }

  db.exec("BEGIN");
  try {
    const seen = new Set<string>();

    for (const kind of LOAD_ORDER) {
      for (const file of files) {
        if (file.identity.kind !== kind) {
          continue;
        }
        seen.add(file.identity.path);

        const previous = known.get(file.identity.path);
        if (
          previous &&
          previous.mtime_ms === file.mtimeMs &&
          previous.size === file.size
        ) {
          continue;
        }

        const bytes = fs.readFileSync(file.absolutePath);
        const hash = fileHash(bytes);
        stats.hashed += 1;

        if (previous && previous.file_hash === hash) {
          // Metadata moved but content did not — refresh the stat cache only.
          db.prepare(
            "UPDATE file_state SET mtime_ms = ?, size = ? WHERE path = ?",
          ).run(file.mtimeMs, file.size, file.identity.path);
          continue;
        }

        clearFile(db, file.identity);
        (stats.changed ??= []).push(file.identity.path);
        if (loadScannedFile(db, file, bytes, hash, stats)) {
          stats.parsed += 1;
        }
      }
    }

    const now = Date.now();
    for (const knownPath of known.keys()) {
      if (!seen.has(knownPath)) {
        const identity = classify(knownPath);
        if (identity) {
          retirePath(db, knownPath, identity, { now, graceMs: DELETE_GRACE_MS });
        } else {
          db.prepare("DELETE FROM file_state WHERE path = ?").run(knownPath);
        }
        stats.removed += 1;
      }
    }

    // A file that moved shows up here as a change; cancel any tombstone the
    // same pass just created for its old path.
    for (const relative of stats.changed ?? []) {
      reviveMoved(db, relative, now);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  stats.durationMs = Date.now() - started;
  return stats;
}

export function loadScannedFile(
  db: DatabaseSync,
  file: ScannedFile,
  bytes: Buffer,
  hash: string,
  stats: ReindexStats,
): boolean {
  let uid: string | null = null;
  let ok = true;

  try {
    const records = buildRecords(file.identity, bytes);
    records.apply(db);
    uid = records.uid;
  } catch (error) {
    ok = false;
    stats.failed += 1;
    db.prepare(
      `INSERT INTO index_errors(path, uid, project, stage, reason, detail, detected_at)
       VALUES(?,?,?,'A',?,?,?)
       ON CONFLICT(path) DO UPDATE SET reason = excluded.reason,
                                       detail = excluded.detail,
                                       detected_at = excluded.detected_at`,
    ).run(
      file.identity.path,
      null,
      file.identity.project,
      isParseError(error) ? error.reason : "unexpected",
      error instanceof Error ? error.message : String(error),
      Date.now(),
    );
  }

  db.prepare(
    `INSERT INTO file_state(path, kind, uid, project, mtime_ms, size, file_hash, indexed_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, uid = excluded.uid,
       project = excluded.project, mtime_ms = excluded.mtime_ms, size = excluded.size,
       file_hash = excluded.file_hash, indexed_at = excluded.indexed_at`,
  ).run(
    file.identity.path,
    file.identity.kind,
    uid,
    file.identity.project,
    file.mtimeMs,
    file.size,
    hash,
    Date.now(),
  );

  return ok;
}

/** Removes everything a file contributed, so a reload cannot leave residue. */
export function clearFile(db: DatabaseSync, identity: FileIdentity): void {
  db.prepare("DELETE FROM index_errors WHERE path = ?").run(identity.path);

  switch (identity.kind) {
    case "issue": {
      const row = db
        .prepare("SELECT uid FROM issues WHERE path = ?")
        .get(identity.path) as { uid?: string } | undefined;
      if (row?.uid) {
        db.prepare("DELETE FROM issues_fts WHERE uid = ?").run(row.uid);
      }
      db.prepare("DELETE FROM issues WHERE path = ?").run(identity.path);
      break;
    }
    case "project":
      db.prepare("DELETE FROM projects WHERE path = ?").run(identity.path);
      break;
    case "sprint":
      db.prepare("DELETE FROM sprints WHERE path = ?").run(identity.path);
      break;
    case "comment":
      db.prepare("DELETE FROM comments WHERE body_path = ?").run(identity.path);
      break;
    case "comment_ops":
      db.prepare(
        "UPDATE comments SET resolved = 0, deleted = 0, ops_applied = 0, ops_path = NULL WHERE ops_path = ?",
      ).run(identity.path);
      break;
    case "run":
      db.prepare("DELETE FROM runs WHERE path = ?").run(identity.path);
      break;
    case "event":
      db.prepare("DELETE FROM events WHERE source_path = ?").run(identity.path);
      break;
    default:
      break;
  }
}

/**
 * Reindexes exactly one file.
 *
 * The write path knows precisely which file it touched, so a full scan would
 * be wasted work — and would also pick up unrelated concurrent edits into a
 * transaction that is supposed to be about one write.
 */
export function syncPath(
  boardRoot: string,
  db: DatabaseSync,
  relativePath: string,
): void {
  const identity = classify(relativePath);
  if (!identity) {
    return;
  }

  const absolute = path.join(boardRoot, relativePath);
  const stats: ReindexStats = {
    scanned: 1, parsed: 0, hashed: 0, removed: 0, failed: 0, durationMs: 0,
  };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    // Deleted through the API. Same policy as a deletion noticed by a scan: the
    // row becomes a tombstone rather than vanishing, so the history survives and
    // a later lookup can still say where the file was (r01b, r08c).
    retirePath(db, relativePath, identity, { now: Date.now(), graceMs: DELETE_GRACE_MS });
    return;
  }

  clearFile(db, identity);

  const bytes = fs.readFileSync(absolute);
  loadScannedFile(
    db,
    {
      identity,
      absolutePath: absolute,
      mtimeMs: Math.floor(stat.mtimeMs),
      size: stat.size,
    },
    bytes,
    fileHash(bytes),
    stats,
  );
}

export function lastRebuildAt(db: DatabaseSync): number | null {
  const value = getMeta(db, "last_full_rebuild_at");
  return value === null ? null : Number(value);
}
