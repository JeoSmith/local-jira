import fs from "node:fs";
import path from "node:path";

import { buildEvent } from "../domain/events.ts";
import type { WritableBoard } from "./board.ts";
import { classify } from "./layout.ts";
import { patchRekey } from "../domain/update.ts";
import { planRekeys, type Claimant, type Rekey } from "../domain/rekey.ts";
import { fileHash } from "./resource.ts";
import { incrementalSync } from "./reindex.ts";
import {
  fullReconcile,
  type ReconcileReason,
  type ReconcileReport,
} from "./reconcile.ts";

export interface ExternalChange {
  path: string;
  uid: string | null;
  key: string | null;
}

export interface ReconcileResult {
  changed: ExternalChange[];
  events: number;
  removed: number;
}

/**
 * Reconciles changes made outside the API and records who made them.
 *
 * The echo problem is handled by the index rather than by bookkeeping: a file
 * the server itself just wrote already has its hash in `file_state`, so the
 * incremental scan sees no difference and produces no change to report. Only a
 * file whose content differs from what the server recorded is external
 * (design §3.5).
 */
export async function reconcileExternal(
  writable: WritableBoard,
): Promise<ReconcileResult> {
  const board = writable.board;
  const stats = incrementalSync(board.boardRoot, board.db);
  const changed = (stats.changed ?? []).filter(isReportable);

  const result: ReconcileResult = {
    changed: [],
    events: 0,
    removed: stats.removed,
  };

  for (const relative of changed) {
    const row = board.db
      .prepare("SELECT uid, key FROM issues WHERE path = ?")
      .get(relative) as { uid?: string; key?: string } | undefined;

    const change: ExternalChange = {
      path: relative,
      uid: row?.uid ?? null,
      key: row?.key ?? null,
    };
    result.changed.push(change);

    await writable.writer.write({
      kind: "event",
      targetPath: relative,
      contents: null,
      event: buildEvent(board.localDirectory, {
        verb: "issue.changed_externally",
        targetKind: "issue",
        targetUid: change.uid,
        // §5.7: a change that did not come through the API has no
        // authenticated actor, and a git author is a guess. Recording one as
        // actor_id would put an unverified identity into the audit trail.
        actor: { id: "unknown", kind: "external" },
        detail: { key: change.key, path: change.path, source_commit: null },
      }),
      actorId: null,
      actorKind: "external",
    });
    result.events += 1;
  }

  return result;
}

export interface FullReconcileResult extends ReconcileResult {
  report: ReconcileReport;
  /** Display keys the board moved on its own to settle a collision (§3.8). */
  rekeyed: Rekey[];
}

/**
 * Reconciles the entire board and records what changed underneath us.
 *
 * Used when the batch cannot be trusted to be complete — a git checkout, a
 * watcher overflow, startup. The events it writes are the observations, not
 * conclusions: a file that vanished is recorded as deleted because that is what
 * the board now shows, and a file that comes back within grace is recorded as a
 * move. Both statements are true of what was seen, and together they read as a
 * coherent history rather than a deletion that silently un-happened.
 */
export async function reconcileFull(
  writable: WritableBoard,
  reason: ReconcileReason,
): Promise<FullReconcileResult> {
  const board = writable.board;
  const report = fullReconcile(board.boardRoot, board.db, { reason });

  const result: FullReconcileResult = {
    changed: [],
    events: 0,
    removed: report.tombstoned.length,
    report,
    rekeyed: [],
  };

  const record = async (
    verb: "issue.changed_externally" | "issue.deleted" | "issue.rekeyed",
    targetPath: string,
    uid: string | null,
    detail: Record<string, string | null>,
  ): Promise<void> => {
    await writable.writer.write({
      kind: "event",
      targetPath,
      contents: null,
      event: buildEvent(board.localDirectory, {
        verb,
        targetKind: "issue",
        targetUid: uid,
        // §5.7: no authenticated actor, and a git author is a guess.
        actor: { id: "unknown", kind: "external" },
        detail: { ...detail, reason, source_commit: null },
      }),
      actorId: null,
      actorKind: "external",
    });
    result.events += 1;
  };

  for (const relative of report.changed.filter(isReportable)) {
    const row = board.db
      .prepare("SELECT uid, key FROM issues WHERE path = ?")
      .get(relative) as { uid?: string; key?: string } | undefined;

    const change: ExternalChange = {
      path: relative,
      uid: row?.uid ?? null,
      key: row?.key ?? null,
    };
    result.changed.push(change);
    await record("issue.changed_externally", relative, change.uid, {
      key: change.key,
      path: change.path,
    });
  }

  for (const moved of report.renamed) {
    await record("issue.rekeyed", moved.to, moved.uid, {
      from_path: moved.from,
      to_path: moved.to,
      key: moved.key,
    });
  }

  for (const gone of report.tombstoned) {
    await record("issue.deleted", gone.path, gone.uid, { key: gone.key, path: gone.path });
  }

  // Last, and only on a full pass: the plan needs the whole merged set, and a
  // pull is the only way two clones' keys end up in the same tree.
  result.rekeyed = await applyRekeys(writable);

  return result;
}

/**
 * Resolves display-key collisions left by a merge.
 *
 * Runs after the index is current, because the plan is computed from the whole
 * merged file set and nothing smaller will do (§3.8). Writes go through the
 * ordinary writer, so a crash mid-rekey replays like any other write — and
 * because the plan is deterministic, recomputing it after that crash reaches
 * the same answer rather than pushing the keys along a second time.
 */
export async function applyRekeys(writable: WritableBoard): Promise<Rekey[]> {
  const board = writable.board;
  const projects = (
    board.db
      .prepare("SELECT DISTINCT project FROM issues WHERE state = 'OK'")
      .all() as Array<{ project: string }>
  ).map((row) => row.project);

  const applied: Rekey[] = [];

  for (const project of projects) {
    const claimants = (
      board.db
        .prepare("SELECT uid, key, path FROM issues WHERE project = ? AND state = 'OK'")
        .all(project) as Claimant[]
    ).map((row) => ({ ...row }));

    for (const rekey of planRekeys({ project, claimants })) {
      const absolute = path.join(board.boardRoot, rekey.path);
      if (!fs.existsSync(absolute)) {
        continue;
      }
      const original = fs.readFileSync(absolute, "utf8");
      const patched = patchRekey(original, rekey.from, rekey.to);
      if (patched === original) {
        continue;
      }

      await writable.writer.write({
        kind: "update",
        targetPath: rekey.path,
        contents: patched,
        expectedHash: fileHash(Buffer.from(original, "utf8")),
        event: buildEvent(board.localDirectory, {
          verb: "issue.rekeyed",
          targetKind: "issue",
          targetUid: rekey.uid,
          // Nobody asked for this. The board did it to keep two offline
          // creations from claiming one key, and the record has to say so.
          actor: { id: null, kind: "system" },
          before: { key: rekey.from },
          after: { key: rekey.to },
          detail: { reason: "duplicate_key", path: rekey.path },
        }),
        actorId: null,
        actorKind: "system",
      });
      applied.push(rekey);
    }
  }

  return applied;
}

/** Only entities a person edits produce an external event. */
function isReportable(relative: string): boolean {
  const identity = classify(relative);
  if (!identity) {
    return false;
  }
  // Event files are append-only records of changes; an event about an event
  // would recurse on every reconciliation.
  return identity.kind !== "event";
}
