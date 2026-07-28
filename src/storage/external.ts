import fs from "node:fs";
import path from "node:path";

import { buildEvent } from "../domain/events.ts";
import type { WritableBoard } from "./board.ts";
import { classify } from "./layout.ts";
import { incrementalSync } from "./reindex.ts";

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
