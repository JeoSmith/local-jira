import fs from "node:fs";
import path from "node:path";

import { createUlid } from "../bootstrap/identifier.ts";
import { buildEvent } from "./events.ts";
import { timestamp, type Actor } from "./issue.ts";
import { canonicalJson, type JsonValue } from "../storage/jcs.ts";
import { findIssue, type BoardHandle, type WritableBoard } from "../storage/board.ts";

/** The four §6.3 names, and no others. */
export const COMMENT_KINDS = ["general", "question", "decision", "review_request"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

/**
 * The default when a request does not say (S4-D1).
 *
 * `general`, deliberately: `question` and `review_request` stop an issue from
 * being picked up, and a gate that closes because somebody forgot a field is a
 * gate people learn to route around by not commenting.
 */
export const DEFAULT_KIND: CommentKind = "general";

export const COMMENT_OPS = ["resolve", "unresolve", "edit", "delete"] as const;
export type CommentOpKind = (typeof COMMENT_OPS)[number];

export function isCommentKind(value: string): value is CommentKind {
  return (COMMENT_KINDS as readonly string[]).includes(value);
}

export function isCommentOp(value: string): value is CommentOpKind {
  return (COMMENT_OPS as readonly string[]).includes(value);
}

export interface CommentRecord {
  commentId: string;
  issueKey: string;
  authorId: string | null;
  authorName: string | null;
  actorKind: string | null;
  kind: CommentKind;
  body: string;
  resolved: boolean;
  deleted: boolean;
  createdAt: string | null;
}

export class CommentError extends Error {
  readonly code: string;
  readonly detail: string | null;

  constructor(code: string, message: string, detail: string | null = null) {
    super(message);
    this.name = "CommentError";
    this.code = code;
    this.detail = detail;
  }
}

function bodyPath(issueKey: string, commentId: string): string {
  return `comments/${issueKey}/${commentId}.md`;
}

function opsPath(issueKey: string, commentId: string): string {
  return `comments/${issueKey}/${commentId}.ops.jsonl`;
}

export interface AddCommentInput {
  issue: string;
  body: string;
  kind?: string;
  idempotency?: { actorId: string; key: string };
}

/**
 * Writes one comment as one file.
 *
 * One file per comment is what makes two people commenting on the same issue
 * from two clones a non-event: they write different paths, so git has nothing
 * to reconcile (§5.3, AC11). It is also why the original is never rewritten —
 * see `appendOp`.
 */
export async function addComment(
  writable: WritableBoard,
  input: AddCommentInput,
  actor: Actor,
  authorName: string | null,
): Promise<CommentRecord> {
  const board = writable.board;

  const body = input.body.trim();
  if (body === "") {
    throw new CommentError("E_COMMENT_EMPTY", "A comment needs something in it.");
  }

  const kind = input.kind === undefined ? DEFAULT_KIND : input.kind;
  if (!isCommentKind(kind)) {
    throw new CommentError(
      "E_INVALID_COMMENT_KIND",
      `"${kind}" is not a comment kind.`,
      `Allowed: ${COMMENT_KINDS.join(", ")}`,
    );
  }

  const found = findIssue(board, input.issue);
  if (!found || !("issue" in found)) {
    throw new CommentError("E_UNKNOWN_ISSUE", `No issue ${input.issue}.`);
  }
  const issue = found.issue;

  const commentId = createUlid();
  const now = timestamp(projectTimezone(board, issue.key));
  const relative = bodyPath(issue.key, commentId);

  const front = [
    "---",
    `comment_id: ${commentId}`,
    `author_id: ${yaml(actor.id)}`,
    `author_name: ${yaml(authorName ?? actor.id)}`,
    `actor_kind: ${actor.kind}`,
    `kind: ${kind}`,
    `created_at: ${now}`,
    "schema_version: 1",
    "---",
    "",
    body,
    "",
  ].join("\n");

  await writable.writer.write({
    kind: "create",
    targetPath: relative,
    contents: front,
    expectedHash: null,
    event: buildEvent(board.localDirectory, {
      verb: "comment.added",
      targetKind: "comment",
      targetUid: commentId,
      actor,
      after: { comment_id: commentId, issue: issue.key, kind },
      at: now,
    }),
    actorId: actor.id,
    actorKind: actor.kind,
    idempotency: input.idempotency,
  });

  const stored = findComment(board, commentId);
  if (stored === null) {
    throw new CommentError(
      "E_COMMENT_NOT_READABLE",
      `${commentId} was written but could not be read back.`,
    );
  }
  return stored;
}

export interface AppendOpInput {
  op: CommentOpKind;
  /** New text, for `edit`. */
  body?: string;
}

/**
 * Adds one op to a comment's log. The original file is never touched.
 *
 * Two clones can both act on the same comment and produce no conflict, because
 * each appends its own line rather than rewriting a shared field. The current
 * state is what replaying those lines says it is (§6.3), which is also why the
 * op needs an id: `op_id` is a ULID, so every clone replays in the same order
 * regardless of where a merge happened to place the line (S4-D3).
 */
export async function appendOp(
  writable: WritableBoard,
  commentId: string,
  input: AppendOpInput,
  actor: Actor,
  role: string,
): Promise<CommentRecord> {
  const board = writable.board;
  const comment = requireComment(board, commentId);

  requireOpPermission(comment, input.op, actor, role);

  if (input.op === "edit" && (input.body ?? "").trim() === "") {
    throw new CommentError("E_COMMENT_EMPTY", "An edit needs replacement text.");
  }

  const now = timestamp(projectTimezone(board, comment.issueKey));
  const line: Record<string, JsonValue> = {
    op_id: createUlid(),
    comment_id: commentId,
    op: input.op,
    actor: actor.id,
    actor_kind: actor.kind,
    at: now,
    ...(input.op === "edit" ? { payload: { body: (input.body ?? "").trim() } } : {}),
  };

  const relative = opsPath(comment.issueKey, commentId);
  const absolute = path.join(board.boardRoot, relative);
  const existing = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";

  await writable.writer.write({
    kind: existing === "" ? "create" : "update",
    targetPath: relative,
    contents: `${existing}${canonicalJson(line)}\n`,
    // Not `expectedHash`: appending is safe against a concurrent append in a
    // way a rewrite is not, and the writer already serialises per path.
    expectedHash: undefined,
    ...(input.op === "resolve" || input.op === "unresolve"
      ? {
          event: buildEvent(board.localDirectory, {
            verb: "comment.resolved",
            targetKind: "comment",
            targetUid: commentId,
            actor,
            after: { comment_id: commentId, issue: comment.issueKey, op: input.op },
            at: now,
          }),
        }
      : {}),
    actorId: actor.id,
    actorKind: actor.kind,
  });

  return requireComment(board, commentId);
}

/**
 * Who may add which op (S4-D2).
 *
 * `edit` and `delete` belong to the author alone — changing or removing what
 * somebody else said is not a conversation. `resolve` is wider, but not open:
 * an agent may not settle a question asked of it, because the gate exists
 * precisely to stop the asked party from carrying on regardless (§6.3).
 */
function requireOpPermission(
  comment: CommentRecord,
  op: CommentOpKind,
  actor: Actor,
  role: string,
): void {
  const mine = comment.authorId === actor.id;

  if ((op === "edit" || op === "delete") && !mine) {
    throw new CommentError(
      "E_COMMENT_NOT_AUTHOR",
      `Only ${comment.authorId} may ${op} that comment.`,
    );
  }

  if ((op === "resolve" || op === "unresolve") && !mine && role === "agent") {
    throw new CommentError(
      "E_COMMENT_NOT_RESOLVABLE",
      "An agent may not resolve a comment it did not write.",
      "A person decides when a question has been answered.",
    );
  }
}

export function findComment(board: BoardHandle, commentId: string): CommentRecord | null {
  const row = board.db
    .prepare("SELECT * FROM comments WHERE comment_id = ?")
    .get(commentId) as Record<string, unknown> | undefined;
  return row ? toComment(row) : null;
}

/**
 * The comments on an issue, oldest first.
 *
 * Deleted ones are left out of the list but not out of the files: `delete` is
 * an op, and the original plus its log stay on disk (§5.3).
 */
export function listComments(
  board: BoardHandle,
  issueKey: string,
  options: { includeDeleted?: boolean } = {},
): CommentRecord[] {
  const rows = board.db
    .prepare(
      `SELECT * FROM comments
        WHERE issue_key = ?${options.includeDeleted === true ? "" : " AND deleted = 0"}
        ORDER BY created_at, comment_id`,
    )
    .all(issueKey) as Array<Record<string, unknown>>;
  return rows.map(toComment);
}

/**
 * Gating comments for many issues at once.
 *
 * One query for a page rather than one per card: the board and the backlog both
 * need this for every issue they show, and asking per row turns a 50-issue list
 * into 50 round trips through SQLite for a badge.
 */
export function blockingCommentsFor(
  board: BoardHandle,
  issueKeys: string[],
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  if (issueKeys.length === 0) {
    return found;
  }

  const rows = board.db
    .prepare(
      `SELECT issue_key, comment_id FROM comments
        WHERE deleted = 0 AND resolved = 0
          AND kind IN ('question','review_request')
          AND issue_key IN (${issueKeys.map(() => "?").join(",")})
        ORDER BY created_at, comment_id`,
    )
    .all(...issueKeys) as Array<{ issue_key: string; comment_id: string }>;

  for (const row of rows) {
    const list = found.get(row.issue_key) ?? [];
    list.push(row.comment_id);
    found.set(row.issue_key, list);
  }
  return found;
}

/** Unresolved `question` and `review_request`, which are what gate an issue (§6.3). */
export function blockingComments(board: BoardHandle, issueKey: string): CommentRecord[] {
  return listComments(board, issueKey).filter(
    (comment) =>
      !comment.resolved &&
      (comment.kind === "question" || comment.kind === "review_request"),
  );
}

function toComment(row: Record<string, unknown>): CommentRecord {
  const kind = String(row.kind ?? DEFAULT_KIND);
  return {
    commentId: String(row.comment_id),
    issueKey: String(row.issue_key ?? ""),
    authorId: row.author_id === null ? null : String(row.author_id),
    authorName: row.author_name === null ? null : String(row.author_name),
    actorKind: row.actor_kind === null ? null : String(row.actor_kind),
    kind: isCommentKind(kind) ? kind : DEFAULT_KIND,
    // Trimmed: the blank line after the frontmatter is how the file is laid
    // out, not something the author typed, and it would show up wherever the
    // text is quoted — the agent's instruction field most of all.
    body: String(row.body ?? "").trim(),
    resolved: Number(row.resolved) === 1,
    deleted: Number(row.deleted) === 1,
    createdAt: row.created_at === null ? null : String(row.created_at),
  };
}

function requireComment(board: BoardHandle, commentId: string): CommentRecord {
  const comment = findComment(board, commentId);
  if (comment === null) {
    throw new CommentError("E_UNKNOWN_COMMENT", `No comment ${commentId}.`);
  }
  return comment;
}

function projectTimezone(board: BoardHandle, issueKey: string): string | null {
  const project = /^([^-]+)-/.exec(issueKey)?.[1] ?? issueKey;
  const row = board.db
    .prepare("SELECT timezone FROM projects WHERE key = ?")
    .get(project) as { timezone?: string } | undefined;
  return row?.timezone ?? null;
}

function yaml(value: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : JSON.stringify(value);
}
