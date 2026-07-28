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
}

/** Ordered so that a comment's body row exists before its ops are replayed. */
const LOAD_ORDER: FileIdentity["kind"][] = [
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

        if (loadFile(built, file, bytes, hash, stats)) {
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
        if (loadFile(db, file, bytes, hash, stats)) {
          stats.parsed += 1;
        }
      }
    }

    for (const knownPath of known.keys()) {
      if (!seen.has(knownPath)) {
        const identity = classify(knownPath);
        if (identity) {
          clearFile(db, identity);
        }
        db.prepare("DELETE FROM file_state WHERE path = ?").run(knownPath);
        stats.removed += 1;
      }
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  stats.durationMs = Date.now() - started;
  return stats;
}

function loadFile(
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
function clearFile(db: DatabaseSync, identity: FileIdentity): void {
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

  clearFile(db, identity);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    // Deleted: the entity rows are gone, so drop the tracking row too.
    db.prepare("DELETE FROM file_state WHERE path = ?").run(relativePath);
    return;
  }

  const bytes = fs.readFileSync(absolute);
  loadFile(
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
