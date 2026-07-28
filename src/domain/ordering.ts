import fs from "node:fs";
import path from "node:path";

import { findIssue, type BoardHandle, type WritableBoard } from "../storage/board.ts";
import type { JsonValue } from "../storage/jcs.ts";
import { fileHash } from "../storage/resource.ts";
import { buildEvent } from "./events.ts";
import { IssueError, projectTimezone, timestamp, type Actor } from "./issue.ts";
import { between, RankSpaceExhausted, REBALANCE_SPAN, spread } from "./rank.ts";
import { patchRank, PreconditionFailedError, touchMetadata } from "./update.ts";

/** The two orderings are independent: leaving a sprint keeps the backlog spot. */
export const RANK_FIELDS = ["backlog_rank", "board_rank"] as const;
export type RankField = (typeof RANK_FIELDS)[number];

export function isRankField(value: string): value is RankField {
  return (RANK_FIELDS as readonly string[]).includes(value);
}

export interface MoveRequest {
  field: RankField;
  /** uid the issue should follow, or null for the top of the region. */
  after: string | null;
  /** uid the issue should precede, or null for the bottom. */
  before: string | null;
}

export interface MoveResult {
  changed: boolean;
  rank: string;
  /** Issues rewritten to make room, empty on the normal path. */
  rebalanced: string[];
}

export class NeighboursMovedError extends Error {
  readonly code = "E_NEIGHBOURS_MOVED";
  readonly order: string[];

  constructor(order: string[]) {
    super("The neighbours given are no longer next to each other.");
    this.name = "NeighboursMovedError";
    this.order = order;
  }
}

interface Row {
  uid: string;
  key: string;
  path: string;
  rank: string | null;
  sprint_id: string | null;
  status: string | null;
}

/**
 * Moves an issue to sit between two others.
 *
 * The request names both neighbours rather than a position index, because an
 * index means something different the moment anyone else reorders the list. The
 * neighbours are re-checked here, under the writer's lock, so a move computed
 * against a stale view is refused rather than applied somewhere else entirely.
 *
 * The normal path rewrites exactly one file (AC4). Only an exhausted gap makes
 * it touch more, and then it says so.
 */
export async function moveIssue(
  writable: WritableBoard,
  key: string,
  input: MoveRequest,
  actor: Actor,
  ifMatch: string | null = null,
): Promise<MoveResult> {
  const board = writable.board;
  const region = orderedRegion(board, key, input.field);
  const subject = region.find((row) => row.key === key);
  if (!subject) {
    throw new IssueError("E_UNKNOWN_PROJECT", `No issue with key ${key}`);
  }

  // Optional here, unlike a field update. The neighbours already pin the
  // position, so a move does not need a snapshot of the issue to be safe. A
  // caller that sends one is asking for the stronger check, and gets it (R10).
  if (ifMatch !== null) {
    const found = findIssue(board, key);
    if (found && "issue" in found) {
      const current = found.issue.etag;
      if (ifMatch.trim().replace(/^"(.*)"$/, "$1") !== current) {
        throw new PreconditionFailedError(current, found.issue.resource as JsonValue, {});
      }
    }
  }

  const others = region.filter((row) => row.uid !== subject.uid);
  const afterIndex = indexOfNeighbour(others, input.after);
  const beforeIndex = indexOfNeighbour(others, input.before);

  if (afterIndex === -2 || beforeIndex === -2) {
    throw new IssueError("E_UNKNOWN_PROJECT", "A neighbour in the request is not in this region.");
  }
  // Adjacent means "nothing between them now". Anything else and the client is
  // describing a list that has since changed.
  const expected = afterIndex === -1 ? 0 : afterIndex + 1;
  if (beforeIndex !== -1 && beforeIndex !== expected) {
    throw new NeighboursMovedError(others.map((row) => row.key));
  }
  if (beforeIndex === -1 && input.before !== null) {
    throw new NeighboursMovedError(others.map((row) => row.key));
  }
  if (input.before === null && expected !== others.length) {
    throw new NeighboursMovedError(others.map((row) => row.key));
  }

  const lower = afterIndex === -1 ? null : others[afterIndex].rank;
  const upper = beforeIndex === -1 ? null : others[beforeIndex].rank;

  // Already there: no file, no event, nothing in `git status` (ADR-005 §2).
  const currentIndex = region.findIndex((row) => row.uid === subject.uid);
  if (currentIndex === expected && subject.rank !== null) {
    return { changed: false, rank: subject.rank, rebalanced: [] };
  }

  let rank: string;
  let rebalanced: string[] = [];

  try {
    rank = between(lower, upper);
  } catch (error) {
    if (!(error instanceof RankSpaceExhausted)) {
      throw error;
    }
    // The gap is used up. Respread a window around it and try once more; if it
    // still will not fit, the region is beyond what a local fix can do.
    rebalanced = await rebalance(writable, others, expected, input.field, actor);
    const refreshed = orderedRegion(board, key, input.field).filter(
      (row) => row.uid !== subject.uid,
    );
    rank = between(
      expected === 0 ? null : refreshed[expected - 1].rank,
      expected >= refreshed.length ? null : refreshed[expected].rank,
    );
  }

  await writeRank(writable, subject, input.field, rank, actor, {
    from: subject.rank,
    to: rank,
  });

  return { changed: true, rank, rebalanced };
}

/**
 * Respreads a window of the region so there is room again.
 *
 * Bounded to `REBALANCE_SPAN` either side (S1-D13) rather than the whole list:
 * a rebalance rewrites every file it touches, and rewriting a 5,000-issue
 * backlog because two cards collided would put the entire project in one commit.
 *
 * Not atomic across files. Each write is atomic on its own and the whole set is
 * checked for staleness first, but an interruption part-way leaves some issues
 * respread and some not. That order is still identical on every clone — it is
 * derived from the files — and the next exhausted insert respreads again. A
 * single multi-file transaction is what ADR-005 asks for and needs the outbox
 * to carry more than one path; it is not in this milestone.
 */
async function rebalance(
  writable: WritableBoard,
  others: Row[],
  around: number,
  field: RankField,
  actor: Actor,
): Promise<string[]> {
  const start = Math.max(0, around - REBALANCE_SPAN);
  const end = Math.min(others.length, around + REBALANCE_SPAN);
  const window = others.slice(start, end);
  if (window.length === 0) {
    throw new RankSpaceExhausted(null, null);
  }

  const lower = start === 0 ? null : others[start - 1].rank;
  const upper = end >= others.length ? null : others[end].rank;
  const fresh = spread(window.length, lower, upper);

  // Every target verified before anything is written: a half-applied rebalance
  // computed against a stale snapshot is worse than one that never started.
  for (const row of window) {
    const absolute = path.join(writable.board.boardRoot, row.path);
    if (!fs.existsSync(absolute)) {
      throw new IssueError("E_KEY_COLLISION", `${row.key} disappeared while rebalancing.`);
    }
  }

  const touched: string[] = [];
  for (const [index, row] of window.entries()) {
    if (row.rank === fresh[index]) {
      continue;
    }
    await writeRank(writable, row, field, fresh[index], actor, {
      from: row.rank,
      to: fresh[index],
      rebalance: true,
    });
    touched.push(row.key);
  }

  process.stdout.write(
    `localjira: rebalanced ${touched.length} issue(s) of ${field} ` +
      `between ${lower ?? "(start)"} and ${upper ?? "(end)"}\n`,
  );
  return touched;
}

async function writeRank(
  writable: WritableBoard,
  row: Row,
  field: RankField,
  rank: string,
  actor: Actor,
  detail: { from: string | null; to: string; rebalance?: boolean },
): Promise<void> {
  const board = writable.board;
  const absolute = path.join(board.boardRoot, row.path);
  const original = fs.readFileSync(absolute, "utf8");
  const patched = patchRank(original, field, rank);
  if (patched === original) {
    return;
  }

  const now = timestamp(projectTimezone(board, row.key.split("-")[0]));
  await writable.writer.write({
    kind: "update",
    targetPath: row.path,
    contents: touchMetadata(patched, now, actor.kind),
    expectedHash: fileHash(Buffer.from(original, "utf8")),
    event: buildEvent(board.localDirectory, {
      verb: "issue.updated",
      targetKind: "issue",
      targetUid: row.uid,
      actor: { id: actor.id, kind: actor.kind },
      before: { [field]: detail.from },
      after: { [field]: detail.to },
      detail: {
        key: row.key,
        field,
        ...(detail.rebalance === true ? { rebalance: true } : {}),
      },
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
  });
}

/**
 * The region an issue is ordered within, sorted by `(rank, uid)`.
 *
 * The uid tie-break is what makes a merged board deterministic: two clones that
 * inserted into the same gap produce the same rank, and without a second key
 * they would each sort those two issues however their database felt like it
 * (ADR-005 §1). A duplicate rank is a rebalance candidate, not an error.
 */
export function orderedRegion(
  board: BoardHandle,
  key: string,
  field: RankField,
): Row[] {
  const subject = board.db
    .prepare("SELECT project, sprint_id, status FROM issues WHERE key = ? AND state = 'OK'")
    .get(key) as { project: string; sprint_id: string | null; status: string | null } | undefined;

  if (!subject) {
    throw new IssueError("E_UNKNOWN_PROJECT", `No issue with key ${key}`);
  }

  const rows =
    field === "backlog_rank"
      ? (board.db
          .prepare(
            `SELECT uid, key, path, backlog_rank AS rank, sprint_id, status FROM issues
              WHERE project = ? AND state = 'OK'
              ORDER BY backlog_rank IS NULL, backlog_rank, uid`,
          )
          .all(subject.project) as Row[])
      : (board.db
          .prepare(
            `SELECT uid, key, path, board_rank AS rank, sprint_id, status FROM issues
              WHERE state = 'OK' AND sprint_id IS ? AND status IS ?
              ORDER BY board_rank IS NULL, board_rank, uid`,
          )
          .all(subject.sprint_id, subject.status) as Row[]);

  return rows.map((row) => ({ ...row }));
}

/** -1 for "no neighbour", -2 for "named a uid this region does not hold". */
function indexOfNeighbour(rows: Row[], uid: string | null): number {
  if (uid === null) {
    return -1;
  }
  const index = rows.findIndex((row) => row.uid === uid);
  return index === -1 ? -2 : index;
}
