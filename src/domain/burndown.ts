import fs from "node:fs";
import path from "node:path";

import { findSprint, listSprints, type Actor } from "./sprint.ts";
import { timestamp } from "./issue.ts";
import { fileHash } from "../storage/resource.ts";
import type { BoardHandle, WritableBoard } from "../storage/board.ts";

/**
 * One day's measurement of a sprint.
 *
 * D12 puts these in the sprint file rather than deriving them from the event
 * log: the log is collaboration history, not tamper-evident (§5.7), and anyone
 * can edit it. A chart resting on that is a chart nobody can quote. In the file
 * they also survive losing the index, so the same graph comes back after a
 * rebuild (AC2).
 */
export interface Snapshot {
  /** Project-local date, `YYYY-MM-DD`. */
  date: string;
  /** Points in scope: estimated, not cancelled. */
  scopePoints: number;
  /** Points of those that are DONE. */
  donePoints: number;
  /** Issues with no estimate — outside both numbers above (D8, AC23). */
  unestimated: number;
  /** Cancelled issues — also outside both (AC23). */
  cancelled: number;
  /**
   * Issues in this sprint the board cannot vouch for, and so did not count.
   *
   * Known only while a previous good row survives. After a full rebuild a file
   * that never parsed has no row at all, so nothing says which sprint it
   * belonged to — `unindexed` on the chart carries that case instead (§5.6).
   */
  quarantined: number;
}

export interface Burndown {
  sprintId: string;
  status: string;
  snapshots: Snapshot[];
  /** Today's figures, whether or not they have been written yet. */
  current: Snapshot;
  /** null when nothing in scope is estimated — not zero, which reads as "none done". */
  completion: number | null;
  /**
   * Files anywhere on the board that could not be indexed.
   *
   * Board-wide because that is the honest scope: after a rebuild the tool
   * cannot say which sprint an unparseable file belonged to, and guessing would
   * put a number on the chart that nothing supports. A count with a caveat
   * beats a total that quietly excludes something.
   */
  unindexed: number;
}

/**
 * Counts a sprint as it stands right now.
 *
 * `CANCELLED` and unestimated issues are left out of both the numerator and
 * the denominator, and reported beside them instead. Adding an unestimated
 * issue as zero would make the chart claim to cover a scope it does not, and
 * counting a cancelled one would make abandoning work look like progress
 * (AC23, D8).
 */
export function measure(board: BoardHandle, sprintId: string, today: string): Snapshot {
  const row = board.db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN state = 'OK' AND status != 'CANCELLED' AND points IS NOT NULL
                           THEN points ELSE 0 END), 0) AS scope,
         COALESCE(SUM(CASE WHEN state = 'OK' AND status = 'DONE' AND points IS NOT NULL
                           THEN points ELSE 0 END), 0) AS done,
         COALESCE(SUM(CASE WHEN state = 'OK' AND status != 'CANCELLED' AND points IS NULL
                           THEN 1 ELSE 0 END), 0) AS unestimated,
         COALESCE(SUM(CASE WHEN state = 'OK' AND status = 'CANCELLED' THEN 1 ELSE 0 END), 0)
           AS cancelled,
         COALESCE(SUM(CASE WHEN state = 'INVALID' THEN 1 ELSE 0 END), 0) AS quarantined
       FROM issues WHERE sprint_id = ?`,
    )
    .get(sprintId) as Record<string, number>;

  return {
    date: today,
    scopePoints: Number(row.scope),
    donePoints: Number(row.done),
    unestimated: Number(row.unestimated),
    cancelled: Number(row.cancelled),
    quarantined: Number(row.quarantined),
  };
}

export function burndownOf(board: BoardHandle, sprintId: string): Burndown | null {
  const sprint = findSprint(board, sprintId);
  if (sprint === null) {
    return null;
  }

  const today = localDate(board, sprint.project);
  const current = measure(board, sprintId, today);
  const stored = readSnapshots(board, sprint.path);

  // Today's real figures, whether or not a write has happened since the server
  // came up. A chart that lags the board it sits next to is a chart people
  // stop trusting.
  const snapshots = [...stored.filter((entry) => entry.date !== today), current].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  const unindexed = board.db
    .prepare("SELECT COUNT(*) AS c FROM index_errors") 
    .get() as { c: number };

  return {
    sprintId,
    status: sprint.status,
    snapshots,
    current,
    unindexed: Number(unindexed.c),
    // null, not 0: "nothing is estimated" and "nothing is done" are different
    // states and 0% would report the first as the second.
    completion:
      current.scopePoints === 0
        ? null
        : Math.round((current.donePoints / current.scopePoints) * 1000) / 10,
  };
}

/**
 * Writes today's measurement into the sprint file.
 *
 * Same date replaces (S4-D7), so recording on every write keeps one row per day
 * rather than growing without bound, and the day's last state is the day's
 * value. Returns false when nothing changed, so a quiet board writes no files.
 */
export async function recordSnapshot(
  writable: WritableBoard,
  sprintId: string,
  actor: Actor,
): Promise<boolean> {
  const board = writable.board;
  const sprint = findSprint(board, sprintId);
  if (sprint === null || sprint.status === "PLANNED") {
    // Nothing has started, so there is no elapsed time to plot.
    return false;
  }

  const today = localDate(board, sprint.project);
  const measured = measure(board, sprintId, today);
  const stored = readSnapshots(board, sprint.path);

  const existing = stored.find((entry) => entry.date === today);
  if (existing && same(existing, measured)) {
    return false;
  }

  const merged = [...stored.filter((entry) => entry.date !== today), measured].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  const absolute = path.join(board.boardRoot, sprint.path);
  const original = fs.readFileSync(absolute, "utf8");
  const patched = writeSnapshots(original, merged);
  if (patched === original) {
    return false;
  }

  await writable.writer.write({
    kind: "update",
    targetPath: sprint.path,
    contents: patched,
    expectedHash: fileHash(Buffer.from(original, "utf8")),
    actorId: actor.id,
    actorKind: actor.kind,
  });
  return true;
}

/**
 * Records for every sprint that is running.
 *
 * Called at startup and after a write that could have moved scope or status
 * (S4-D8). There is no scheduler because there is no daemon: this is a server
 * somebody starts, and a day it never ran has no measurement — none is invented
 * for it either.
 */
export async function recordActiveSnapshots(
  writable: WritableBoard,
  actor: Actor,
): Promise<number> {
  const projects = writable.board.db
    .prepare("SELECT key FROM projects")
    .all() as Array<{ key: string }>;

  let written = 0;
  for (const project of projects) {
    for (const sprint of listSprints(writable.board, project.key, "ACTIVE")) {
      if (await recordSnapshot(writable, sprint.id, actor)) {
        written += 1;
      }
    }
  }
  return written;
}

function same(a: Snapshot, b: Snapshot): boolean {
  return (
    a.scopePoints === b.scopePoints &&
    a.donePoints === b.donePoints &&
    a.unestimated === b.unestimated &&
    a.cancelled === b.cancelled &&
    a.quarantined === b.quarantined
  );
}

function readSnapshots(board: BoardHandle, sprintPath: string): Snapshot[] {
  const row = board.db
    .prepare("SELECT resource_json FROM sprints WHERE path = ?")
    .get(sprintPath) as { resource_json?: string } | undefined;
  if (!row?.resource_json) {
    return [];
  }

  const parsed = JSON.parse(row.resource_json) as Record<string, unknown>;
  const list = parsed.burndown_snapshots;
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .map((entry) => entry as Record<string, unknown>)
    .filter((entry) => typeof entry?.date === "string")
    .map((entry) => ({
      date: String(entry.date),
      scopePoints: Number(entry.scope_points ?? 0),
      donePoints: Number(entry.done_points ?? 0),
      unestimated: Number(entry.unestimated ?? 0),
      cancelled: Number(entry.cancelled ?? 0),
      quarantined: Number(entry.quarantined ?? 0),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Replaces the snapshot block in a sprint file.
 *
 * Flow maps, one per line, because that is the shape the parser already reads
 * for `links` and because one line per day keeps a diff legible — a person
 * reviewing the commit sees which day changed.
 */
export function writeSnapshots(original: string, snapshots: Snapshot[]): string {
  const lines = original.split("\n");
  const start = lines.findIndex((line) => /^burndown_snapshots:(\s|$)/.test(line));

  const block = [
    "burndown_snapshots:",
    ...snapshots.map(
      (entry) =>
        `  - {date: ${entry.date}, scope_points: ${entry.scopePoints}, ` +
        `done_points: ${entry.donePoints}, unestimated: ${entry.unestimated}, ` +
        `cancelled: ${entry.cancelled}, quarantined: ${entry.quarantined}}`,
    ),
  ];

  if (start === -1) {
    const anchor = lines.findIndex((line) => /^schema_version:/.test(line));
    return anchor === -1
      ? [...lines, ...block].join("\n")
      : [...lines.slice(0, anchor), ...block, ...lines.slice(anchor)].join("\n");
  }

  let end = start + 1;
  while (end < lines.length && /^\s+-\s/.test(lines[end])) {
    end += 1;
  }
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
}

/** Today, in the project's own timezone — a chart's day boundary is local. */
function localDate(board: BoardHandle, project: string): string {
  const row = board.db
    .prepare("SELECT timezone FROM projects WHERE key = ?")
    .get(project) as { timezone?: string } | undefined;
  return timestamp(row?.timezone ?? null).slice(0, 10);
}
