import { unindexedCount } from "../storage/integrity.ts";
import type { BoardHandle } from "../storage/board.ts";
import { IssueError } from "./issue.ts";

export const LINK_KINDS = ["blocks", "blocked_by", "relates_to", "duplicates"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** Statuses that release a blocker. `CANCELLED` counts as done (S1-D5). */
const SETTLED = new Set(["DONE", "CANCELLED"]);

export interface Link {
  id: string;
  kind: LinkKind;
  to: string;
}

export interface RelatedIssue {
  id: string;
  kind: LinkKind;
  /** True when this side declared it; false when it is the index's reverse. */
  declared: boolean;
  uid: string;
  key: string | null;
  title: string | null;
  status: string | null;
  type: string | null;
}

/**
 * A link's identifier.
 *
 * Derived from the pair rather than assigned, so it survives the file being
 * reordered by hand and stays the same across clones. A positional index would
 * change meaning the moment somebody inserted a line above it.
 */
export function linkId(kind: LinkKind, to: string): string {
  return `${kind}:${to}`;
}

export function parseLinkId(value: string): Link | null {
  const separator = value.indexOf(":");
  if (separator === -1) {
    return null;
  }
  const kind = value.slice(0, separator);
  const to = value.slice(separator + 1);
  if (!isLinkKind(kind) || to === "") {
    return null;
  }
  return { id: value, kind, to };
}

export function isLinkKind(value: string): value is LinkKind {
  return (LINK_KINDS as readonly string[]).includes(value);
}

/** The links an issue file declares, in the order the file lists them. */
export function declaredLinks(resource: unknown): Link[] {
  const raw = (resource as Record<string, unknown> | null)?.links;
  if (!Array.isArray(raw)) {
    return [];
  }

  const links: Link[] = [];
  for (const entry of raw) {
    const row = entry as Record<string, unknown> | null;
    const kind = String(row?.kind ?? "");
    const to = String(row?.to ?? "");
    if (isLinkKind(kind) && to !== "") {
      links.push({ id: linkId(kind, to), kind, to });
    }
  }
  return links;
}

/**
 * Checks a proposed link and returns it.
 *
 * `blocks` and `blocked_by` are the same relation seen from two sides, and
 * S1-D4 stores it only on the side that declared it. That is why nothing here
 * writes to the other issue's file: one relation, one file, one merge conflict
 * surface instead of two and no half-applied state.
 */
export function validateLink(
  board: BoardHandle,
  fromUid: string,
  kind: string,
  to: string,
): Link {
  if (!isLinkKind(kind)) {
    throw new IssueError(
      "E_INVALID_LINK_KIND",
      `"${kind}" is not a link kind.`,
      `Allowed: ${LINK_KINDS.join(", ")}.`,
    );
  }
  if (to === fromUid) {
    throw new IssueError("E_LINK_SELF", "An issue cannot be linked to itself (S1-D4).");
  }

  const target = board.db
    .prepare("SELECT uid FROM issues WHERE uid = ? AND state = 'OK'")
    .get(to) as { uid: string } | undefined;
  if (!target) {
    throw new IssueError(
      "E_LINK_TARGET_NOT_FOUND",
      `No issue with uid ${to} to link to.`,
      unindexedHint(board),
    );
  }

  return { id: linkId(kind, to), kind, to };
}

/**
 * Everything related to an issue, from both directions.
 *
 * Reverses are computed rather than stored, so a relation shows up on both
 * issues even though only one file mentions it. `declared` says which side this
 * is, because only the declaring side can remove it.
 */
export function relatedTo(board: BoardHandle, uid: string): RelatedIssue[] {
  const rows = board.db
    .prepare(
      `SELECT l.kind AS kind, l.to_uid AS other, 1 AS declared
         FROM issue_links l WHERE l.from_uid = ?
       UNION ALL
       SELECT l.kind AS kind, l.from_uid AS other, 0 AS declared
         FROM issue_links l WHERE l.to_uid = ?`,
    )
    .all(uid, uid) as Array<{ kind: string; other: string; declared: number }>;

  const seen = new Set<string>();
  const related: RelatedIssue[] = [];

  for (const row of rows) {
    if (!isLinkKind(row.kind)) {
      continue;
    }
    // A reverse row describes the relation from the other end, so the kind it
    // means for *this* issue is the opposite one.
    const kind = row.declared === 1 ? row.kind : inverseOf(row.kind);
    const key = `${kind}:${row.other}`;
    if (seen.has(key)) {
      // Both sides declared it. One relation, reported once (S1-D4).
      continue;
    }
    seen.add(key);

    const issue = board.db
      .prepare("SELECT uid, key, title, status, type FROM issues WHERE uid = ? AND state = 'OK'")
      .get(row.other) as
      | { uid: string; key: string; title: string; status: string; type: string }
      | undefined;

    related.push({
      id: linkId(kind, row.other),
      kind,
      declared: row.declared === 1,
      uid: row.other,
      key: issue?.key ?? null,
      title: issue?.title ?? null,
      status: issue?.status ?? null,
      type: issue?.type ?? null,
    });
  }

  return related.sort((a, b) => a.id.localeCompare(b.id));
}

function inverseOf(kind: LinkKind): LinkKind {
  if (kind === "blocks") {
    return "blocked_by";
  }
  if (kind === "blocked_by") {
    return "blocks";
  }
  // relates_to and duplicates read the same from either end.
  return kind;
}

export interface Claimability {
  claimable: boolean;
  /** Keys of the issues still in the way, for a message a person can act on. */
  blockedBy: string[];
}

/**
 * Whether an issue is free to be picked up, and what is holding it.
 *
 * The reason travels with the answer because an agent that is refused has to
 * report *why* to a person, and "false" on its own sends them looking.
 */
export function claimability(board: BoardHandle, uid: string): Claimability {
  const blockers = relatedTo(board, uid).filter((entry) => entry.kind === "blocked_by");
  const unresolved = blockers.filter(
    (entry) => entry.status === null || !SETTLED.has(entry.status),
  );

  return {
    claimable: unresolved.length === 0,
    blockedBy: unresolved.map((entry) => entry.key ?? entry.uid).sort(),
  };
}


/**
 * What to add to a "no such issue" when the board could not read everything.
 *
 * A file that never parsed leaves no row and no uid anywhere, so a uid naming
 * one is genuinely unresolvable — "not found" is literally true and still
 * misleading. Naming the count keeps the answer honest without pretending the
 * board knows which file was meant.
 */
export function unindexedHint(board: BoardHandle): string | null {
  const count = unindexedCount(board.db);
  return count === 0
    ? null
    : `${count} file(s) could not be indexed; the one you named may be among them. See /integrity/issues.`;
}
