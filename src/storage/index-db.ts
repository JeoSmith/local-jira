import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

import { INDEX_SCHEMA, SCHEMA_VERSION } from "./schema.ts";

export const INDEX_FILENAME = "index.sqlite";
/** Where a rebuild is assembled before it replaces the live index (§3.7). */
export const INDEX_BUILD_FILENAME = "index.new.sqlite";

export interface OpenIndexResult {
  db: DatabaseSync;
  /** True when the caller must run a full rebuild before serving reads. */
  needsRebuild: boolean;
  reason: "fresh" | "schema_version" | "corrupt" | "ok";
}

export function indexPath(localDirectory: string): string {
  return path.join(localDirectory, INDEX_FILENAME);
}

/**
 * Opens the index, rebuilding from scratch if it is missing, stale or corrupt.
 *
 * All three cases collapse to the same answer because the index is derived:
 * there is never a reason to repair it in place when the files can regenerate
 * it, and a repair path would be a second, rarely exercised way to be wrong.
 */
export function openIndex(localDirectory: string): OpenIndexResult {
  fs.mkdirSync(localDirectory, { recursive: true });
  const target = indexPath(localDirectory);

  if (!fs.existsSync(target)) {
    return { db: createIndex(target), needsRebuild: true, reason: "fresh" };
  }

  try {
    const db = new DatabaseSync(target);
    applyPragmas(db);

    const version = readSchemaVersion(db);
    if (version !== SCHEMA_VERSION) {
      db.close();
      fs.rmSync(target, { force: true });
      return {
        db: createIndex(target),
        needsRebuild: true,
        reason: "schema_version",
      };
    }
    return { db, needsRebuild: false, reason: "ok" };
  } catch {
    // A truncated or otherwise unreadable file is not worth diagnosing.
    fs.rmSync(target, { force: true });
    return { db: createIndex(target), needsRebuild: true, reason: "corrupt" };
  }
}

export function createIndex(target: string): DatabaseSync {
  fs.rmSync(target, { force: true });
  const db = new DatabaseSync(target);
  applyPragmas(db);
  db.exec(INDEX_SCHEMA);
  setMeta(db, "schema_version", String(SCHEMA_VERSION));
  return db;
}

function applyPragmas(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  // The index is disposable, so paying for fsync on every commit buys nothing:
  // a torn write is repaired by rebuilding, which is already the recovery path
  // for every other kind of damage (design §3.4).
  db.exec("PRAGMA synchronous = OFF");
  db.exec("PRAGMA foreign_keys = ON");
}

function readSchemaVersion(db: DatabaseSync): number | null {
  try {
    const row = db
      .prepare("SELECT v FROM index_meta WHERE k = 'schema_version'")
      .get() as { v?: string } | undefined;
    return row?.v === undefined ? null : Number(row.v);
  } catch {
    return null;
  }
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO index_meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
  ).run(key, value);
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT v FROM index_meta WHERE k = ?").get(key) as
    | { v?: string }
    | undefined;
  return row?.v ?? null;
}

/**
 * Swaps a freshly built index in for the live one.
 *
 * The build happens in a separate file and only the rename is observable, so
 * readers never see a half-populated index — and never see a *deleted* one,
 * which is what a build-in-place would expose to any connection opened
 * mid-rebuild (§3.7).
 */
export function promoteIndex(
  localDirectory: string,
  built: DatabaseSync,
  builtPath: string,
): DatabaseSync {
  built.close();

  const target = indexPath(localDirectory);
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${target}${suffix}`, { force: true });
  }
  fs.renameSync(builtPath, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${builtPath}${suffix}`)) {
      fs.renameSync(`${builtPath}${suffix}`, `${target}${suffix}`);
    }
  }

  const db = new DatabaseSync(target);
  applyPragmas(db);
  return db;
}
