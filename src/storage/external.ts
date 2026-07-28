import fs from "node:fs";
import path from "node:path";

import { createUlid } from "../bootstrap/identifier.ts";
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
      event: buildExternalEvent(board.localDirectory, change),
      // §5.7: a change that did not come through the API has no authenticated
      // actor. Attributing it to a git author would promote a guess into an
      // identity the audit trail then treats as verified.
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

function buildExternalEvent(
  localDirectory: string,
  change: ExternalChange,
): { eventId: string; path: string; line: string } {
  const eventId = createUlid();
  const at = `${new Date().toISOString().slice(0, 19)}Z`;

  return {
    eventId,
    path: `events/${at.slice(0, 10)}/${nodeId(localDirectory)}.jsonl`,
    line: JSON.stringify({
      event_id: eventId,
      at,
      actor_id: "unknown",
      actor_kind: "external",
      target_kind: "issue",
      target_uid: change.uid,
      verb: "issue.changed_externally",
      detail: {
        key: change.key,
        path: change.path,
        // Recorded only as a hint. It is not evidence of who edited the file,
        // and nothing may treat it as an authenticated actor.
        source_commit: null,
      },
    }),
  };
}

function nodeId(localDirectory: string): string {
  try {
    const contents = fs.readFileSync(path.join(localDirectory, "node.yaml"), "utf8");
    return /^node_id:\s*(\S+)$/m.exec(contents)?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}
