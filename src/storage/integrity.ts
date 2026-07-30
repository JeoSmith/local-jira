import type { DatabaseSync } from "node:sqlite";

/**
 * Why an entity is quarantined.
 *
 * Kept apart rather than collapsed into "broken" because the recovery differs:
 * a conflict marker means finish the merge, a dangling reference means point it
 * somewhere real, a duplicate uid means decide which file is the original. A
 * single code would tell a person their board is broken and nothing else.
 */
export const STAGE_B_REASONS = ["duplicate_uid", "dangling_ref", "cycle"] as const;
export type QuarantineReason = (typeof STAGE_B_REASONS)[number];

/**
 * Stage A reasons come from the parser itself (`conflict_marker`, `yaml_error`,
 * `frontmatter_missing`, …) and are recorded verbatim. They are more specific
 * than a single "parse_error" would be, and the specificity is the useful part:
 * a conflict marker means finish the merge, a reserved field means rename it.
 */

export interface Quarantined {
  path: string;
  uid: string | null;
  key: string | null;
  reason: QuarantineReason;
  detail: string | null;
}

export interface IntegrityReport {
  quarantined: Quarantined[];
  released: string[];
  /** Projects with more than one ACTIVE sprint, which no merge can settle. */
  sprintConflicts: string[];
  /** Rank values shared by more than one issue in a region (r03 rebalances). */
  duplicateRanks: number;
}

/**
 * Stage B: the checks that need the whole board, not one file.
 *
 * Stage A rejects a file the parser cannot read. This pass runs after every
 * file is loaded, because whether a reference dangles or a uid is duplicated is
 * not a property of any single file — it is a property of the set, and a merge
 * is exactly what changes the set without touching most of its members.
 *
 * Quarantine hides an entity; it never deletes one. The row stays so the file
 * can be repaired and the row released, and so the error report can say what
 * the last good version was.
 */
export function validateBoard(db: DatabaseSync, now = Date.now()): IntegrityReport {
  const report: IntegrityReport = {
    quarantined: [],
    released: [],
    sprintConflicts: [],
    duplicateRanks: 0,
  };

  // Start from a clean slate for stage B so a fixed file is released without
  // anybody having to remember which check put it here (AC: auto-release).
  const previouslyInvalid = new Set(
    (
      db
        .prepare(
          `SELECT path FROM issues WHERE state = 'INVALID'
            AND path NOT IN (SELECT path FROM index_errors WHERE stage = 'A')`,
        )
        .all() as Array<{ path: string }>
    ).map((row) => row.path),
  );
  // Only what stage B itself decided. A file the parser could not read is
  // stage A's finding and is still true — releasing it here would put an
  // unreadable file back on the board every time this pass ran.
  db.prepare(
    `UPDATE issues SET state = 'OK'
      WHERE state = 'INVALID'
        AND path NOT IN (SELECT path FROM index_errors WHERE stage = 'A')`,
  ).run();
  db.prepare("DELETE FROM index_errors WHERE stage = 'B'").run();

  const quarantine = (entry: Quarantined): void => {
    db.prepare("UPDATE issues SET state = 'INVALID' WHERE path = ?").run(entry.path);
    db.prepare("DELETE FROM issues_fts WHERE uid = ?").run(entry.uid);
    db.prepare(
      `INSERT INTO index_errors(path, uid, project, stage, reason, detail, last_good_hash, detected_at)
       VALUES(?,?,(SELECT project FROM issues WHERE path = ?),'B',?,?,
              (SELECT file_hash FROM file_state WHERE path = ?),?)
       ON CONFLICT(path) DO UPDATE SET reason = excluded.reason, detail = excluded.detail,
                                       detected_at = excluded.detected_at`,
    ).run(entry.path, entry.uid, entry.path, entry.reason, entry.detail, entry.path, now);
    report.quarantined.push(entry);
  };

  duplicateUids(db, quarantine);
  danglingReferences(db, quarantine);
  cycles(db, quarantine);

  report.sprintConflicts = sprintConflicts(db);
  report.duplicateRanks = markDuplicateRanks(db);

  const stillInvalid = new Set(report.quarantined.map((entry) => entry.path));
  report.released = [...previouslyInvalid].filter((path) => !stillInvalid.has(path));
  return report;
}

/**
 * Two files claiming the same uid.
 *
 * Both go, not one. The uid is the identity, so two files holding it means the
 * board cannot say which is the entity — and picking the newer, or the one
 * whose path sorts first, would silently discard somebody's work.
 */
function duplicateUids(db: DatabaseSync, quarantine: (entry: Quarantined) => void): void {
  const rows = db
    .prepare(
      `SELECT uid, GROUP_CONCAT(path, char(10)) AS paths, COUNT(*) AS count
         FROM issues WHERE state != 'PENDING_DELETE'
        GROUP BY uid HAVING count > 1`,
    )
    .all() as Array<{ uid: string; paths: string; count: number }>;

  for (const row of rows) {
    const paths = row.paths.split("\n");
    for (const path of paths) {
      quarantine({
        path,
        uid: row.uid,
        key: null,
        reason: "duplicate_uid",
        detail:
          `${row.count} files claim uid ${row.uid}: ${paths.join(", ")}. ` +
          "Decide which is the original and give the others a new uid.",
      });
    }
  }
}

/** A parent or sprint that no file provides. */
function danglingReferences(
  db: DatabaseSync,
  quarantine: (entry: Quarantined) => void,
): void {
  const orphans = db
    .prepare(
      `SELECT i.path, i.uid, i.key, i.parent_uid FROM issues i
        WHERE i.state = 'OK' AND i.parent_uid IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM issues p WHERE p.uid = i.parent_uid AND p.state != 'PENDING_DELETE')`,
    )
    .all() as Array<{ path: string; uid: string; key: string; parent_uid: string }>;

  for (const row of orphans) {
    quarantine({
      path: row.path,
      uid: row.uid,
      key: row.key,
      reason: "dangling_ref",
      detail:
        `parent ${row.parent_uid} is not on this board. ` +
        "Remove the parent to make it top level, or point it at an issue that exists.",
    });
  }

  const strandedSprints = db
    .prepare(
      `SELECT i.path, i.uid, i.key, i.sprint_id FROM issues i
        WHERE i.state = 'OK' AND i.sprint_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM sprints s WHERE s.id = i.sprint_id)`,
    )
    .all() as Array<{ path: string; uid: string; key: string; sprint_id: string }>;

  for (const row of strandedSprints) {
    quarantine({
      path: row.path,
      uid: row.uid,
      key: row.key,
      reason: "dangling_ref",
      detail: `sprint ${row.sprint_id} is not on this board. Remove it or restore the sprint file.`,
    });
  }
}

/**
 * Hierarchy cycles.
 *
 * Every member is quarantined, not just the edge that closed the loop: there is
 * no way to tell which link is the wrong one, and hiding an arbitrary member
 * would leave a tree that still lies about its shape.
 */
function cycles(db: DatabaseSync, quarantine: (entry: Quarantined) => void): void {
  const rows = db
    .prepare("SELECT path, uid, key, parent_uid FROM issues WHERE state = 'OK'")
    .all() as Array<{ path: string; uid: string; key: string; parent_uid: string | null }>;

  const byUid = new Map(rows.map((row) => [row.uid, row]));
  const settled = new Set<string>();

  for (const start of rows) {
    if (settled.has(start.uid)) {
      continue;
    }
    const walked: string[] = [];
    const seen = new Set<string>();
    let current: string | null = start.uid;

    while (current !== null && !seen.has(current)) {
      seen.add(current);
      walked.push(current);
      current = byUid.get(current)?.parent_uid ?? null;
      if (current !== null && !byUid.has(current)) {
        current = null;
      }
    }

    if (current === null) {
      for (const uid of walked) {
        settled.add(uid);
      }
      continue;
    }

    // `current` is where the walk re-entered itself: the loop is from there on.
    const loop = walked.slice(walked.indexOf(current));
    const trail = loop.map((uid) => byUid.get(uid)?.key ?? uid);
    for (const uid of loop) {
      settled.add(uid);
      const row = byUid.get(uid);
      if (row) {
        quarantine({
          path: row.path,
          uid: row.uid,
          key: row.key,
          reason: "cycle",
          detail: `parent chain forms a loop: ${[...trail, trail[0]].join(" → ")}`,
        });
      }
    }
  }
}

/**
 * Projects whose merge produced more than one ACTIVE sprint.
 *
 * Reported at project level rather than quarantining anything. The sprints are
 * individually fine; what is broken is the rule that only one may be active,
 * and hiding one of them would decide on the person's behalf which.
 */
function sprintConflicts(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT project FROM sprints WHERE status = 'ACTIVE'
        GROUP BY project HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ project: string }>;
  return rows.map((row) => row.project);
}

/**
 * Issues sharing a rank.
 *
 * Counted, never quarantined. Two clones inserting into the same gap produce
 * the same rank, which is ordinary and already handled: `(rank, uid)` sorts it
 * deterministically. Treating it as an error would let a normal merge stop the
 * board (ADR-005 §1).
 */
function markDuplicateRanks(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT backlog_rank FROM issues
          WHERE state = 'OK' AND backlog_rank IS NOT NULL
          GROUP BY project, backlog_rank HAVING COUNT(*) > 1
       )`,
    )
    .get() as { c: number };
  return Number(row.c);
}

/**
 * Board-level problems that are not any one entity's fault.
 *
 * Reported rather than quarantined: the sprints in a conflict are each valid,
 * and hiding one would decide on the person's behalf which of them counts.
 */
export function boardHealth(db: DatabaseSync): {
  sprintConflicts: string[];
  duplicateRanks: number;
} {
  return { sprintConflicts: sprintConflicts(db), duplicateRanks: markDuplicateRanks(db) };
}

export interface QuarantineRecord {
  path: string;
  uid: string | null;
  key: string | null;
  reason: string;
  detail: string | null;
  lastGoodHash: string | null;
  detectedAt: string;
}

/** Everything currently quarantined, for `GET /integrity/issues`. */
export function quarantineList(db: DatabaseSync): QuarantineRecord[] {
  const rows = db
    .prepare(
      `SELECT e.path, e.uid, e.reason, e.detail, e.last_good_hash, e.detected_at,
              (SELECT key FROM issues WHERE path = e.path) AS key
         FROM index_errors e ORDER BY e.detected_at DESC, e.path`,
    )
    .all() as Array<{
    path: string;
    uid: string | null;
    key: string | null;
    reason: string;
    detail: string | null;
    last_good_hash: string | null;
    detected_at: number;
  }>;

  return rows.map((row) => ({
    path: row.path,
    uid: row.uid,
    key: row.key,
    reason: row.reason,
    detail: row.detail,
    lastGoodHash: row.last_good_hash,
    detectedAt: new Date(row.detected_at).toISOString(),
  }));
}

/** The quarantine record for one issue key, if it has one. */
export function quarantineOf(db: DatabaseSync, key: string): QuarantineRecord | null {
  const row = db
    .prepare(
      `SELECT e.path, e.uid, e.reason, e.detail, e.last_good_hash, e.detected_at, i.key
         FROM issues i JOIN index_errors e ON e.path = i.path
        WHERE i.key = ? AND i.state = 'INVALID' LIMIT 1`,
    )
    .get(key) as
    | {
        path: string;
        uid: string | null;
        key: string;
        reason: string;
        detail: string | null;
        last_good_hash: string | null;
        detected_at: number;
      }
    | undefined;

  if (row) {
    return {
      path: row.path,
      uid: row.uid,
      key: row.key,
      reason: row.reason,
      detail: row.detail,
      lastGoodHash: row.last_good_hash,
      detectedAt: new Date(row.detected_at).toISOString(),
    };
  }

  // No row to join against. That is the normal state after a full rebuild: the
  // file never parsed, so nothing was ever inserted for it, and the join above
  // finds nothing however clearly `index_errors` names the file. Without this
  // fallback a conflicted issue reads as "no such issue" after a rebuild —
  // which is what someone gets after `git clean` or a schema bump, exactly
  // when they most need to be told which file to fix.
  const orphan = db
    .prepare(
      `SELECT path, uid, reason, detail, last_good_hash, detected_at
         FROM index_errors WHERE path = ? LIMIT 1`,
    )
    .get(issuePathFor(db, key)) as
    | {
        path: string;
        uid: string | null;
        reason: string;
        detail: string | null;
        last_good_hash: string | null;
        detected_at: number;
      }
    | undefined;

  return orphan
    ? {
        path: orphan.path,
        uid: orphan.uid,
        key,
        reason: orphan.reason,
        detail: orphan.detail,
        lastGoodHash: orphan.last_good_hash,
        detectedAt: new Date(orphan.detected_at).toISOString(),
      }
    : null;
}

/**
 * Where an issue with this key would live.
 *
 * Derived from the layout rather than looked up, because the lookup is exactly
 * what is unavailable here. The project comes from the key's prefix, which is
 * how keys are minted (`LJ-12` lives under `issues/LJ/`).
 */
function issuePathFor(db: DatabaseSync, key: string): string {
  void db;
  const project = /^([^-]+)-/.exec(key)?.[1] ?? "";
  return `issues/${project}/${key}.md`;
}

/** True when the uid names an entity that is currently quarantined. */
export function isQuarantinedUid(db: DatabaseSync, uid: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM issues WHERE uid = ? AND state = 'INVALID' LIMIT 1")
    .get(uid) as { ok: number } | undefined;
  return row !== undefined;
}
