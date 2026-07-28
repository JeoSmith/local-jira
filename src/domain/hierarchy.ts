import type { BoardHandle } from "../storage/board.ts";
import { ISSUE_TYPES, IssueError, type IssueType } from "./issue.ts";

/**
 * Which parent each type may have (PRD §5.1).
 *
 * Written as the allowed set per child rather than as a depth number, because
 * the rule is not "three levels" — an epic may not have a parent at all, and a
 * subtask may not have children, and both of those are facts about the type
 * rather than about where it happens to sit.
 */
const ALLOWED_PARENTS: Record<IssueType, IssueType[]> = {
  epic: [],
  story: ["epic"],
  task: ["epic"],
  bug: ["epic"],
  spike: ["epic"],
  subtask: ["story", "task", "bug", "spike"],
};

/** Types that cannot be a parent, whatever the child is. */
export function canHaveChildren(type: IssueType): boolean {
  return Object.values(ALLOWED_PARENTS).some((parents) => parents.includes(type));
}

export interface ParentRow {
  uid: string;
  key: string;
  type: string | null;
  parent_uid: string | null;
}

/**
 * Resolves and checks a proposed parent.
 *
 * Returns the parent row so the caller can record the uid; throws with the
 * reason otherwise. Every rejection names both types, because "400" on its own
 * leaves the caller guessing which half of the pair was wrong.
 */
export function validateParent(
  board: BoardHandle,
  childType: IssueType,
  childUid: string | null,
  parentUid: string,
): ParentRow {
  const allowed = ALLOWED_PARENTS[childType];

  if (allowed.length === 0) {
    throw new IssueError(
      "E_PARENT_NOT_ALLOWED",
      `A ${childType} is always top level and cannot have a parent.`,
    );
  }

  const parent = board.db
    .prepare("SELECT uid, key, type, parent_uid FROM issues WHERE uid = ? AND state = 'OK'")
    .get(parentUid) as ParentRow | undefined;

  if (!parent) {
    // Only the API path is this strict. The same violation arriving through a
    // hand-edited file is a quarantine case, not a rejection (R11, §5.6):
    // refusing to load it would make one bad reference hide a whole board.
    throw new IssueError(
      "E_PARENT_NOT_FOUND",
      `No issue with uid ${parentUid} to use as a parent.`,
    );
  }

  if (parent.uid === childUid) {
    throw new IssueError("E_PARENT_CYCLE", "An issue cannot be its own parent.");
  }

  const parentType = parent.type;
  if (parentType === null || !(ISSUE_TYPES as readonly string[]).includes(parentType)) {
    throw new IssueError(
      "E_PARENT_NOT_ALLOWED",
      `${parent.key} has no usable type, so it cannot be a parent.`,
    );
  }
  if (!allowed.includes(parentType as IssueType)) {
    throw new IssueError(
      "E_PARENT_NOT_ALLOWED",
      `A ${childType} may not hang off a ${parentType}.`,
      `Allowed parent types for ${childType}: ${allowed.join(", ")}.`,
    );
  }

  if (childUid !== null && descendsFrom(board, parent.uid, childUid)) {
    throw new IssueError(
      "E_PARENT_CYCLE",
      `${parent.key} is already below this issue, so the link would form a cycle.`,
    );
  }

  return parent;
}

/**
 * Walks up from `uid` looking for `ancestorUid`.
 *
 * The type rules make a cycle unreachable through the API today, but they are
 * not the only way rows get here: a file edited by hand or arriving in a merge
 * can say anything. The walk is bounded by the number of issues so a cycle that
 * already exists in the data cannot spin here forever.
 */
export function descendsFrom(
  board: BoardHandle,
  uid: string,
  ancestorUid: string,
): boolean {
  const seen = new Set<string>();
  let current: string | null = uid;

  while (current !== null && !seen.has(current)) {
    if (current === ancestorUid) {
      return true;
    }
    seen.add(current);
    const row = board.db
      .prepare("SELECT parent_uid FROM issues WHERE uid = ? AND state = 'OK'")
      .get(current) as { parent_uid: string | null } | undefined;
    current = row?.parent_uid ?? null;
  }
  return false;
}

export interface ChildRow {
  uid: string;
  key: string;
  type: string | null;
  status: string | null;
  title: string | null;
  path: string;
}

export function childrenOf(board: BoardHandle, parentUid: string): ChildRow[] {
  return (
    board.db
      .prepare(
        `SELECT uid, key, type, status, title, path FROM issues
          WHERE parent_uid = ? AND state = 'OK' ORDER BY key`,
      )
      .all(parentUid) as ChildRow[]
  ).map((row) => ({ ...row }));
}
