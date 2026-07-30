import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

import { BootstrapError } from "../bootstrap/execute.ts";
import { acquireLock, type BootstrapLock } from "../bootstrap/lock.ts";
import { resolveRepositoryContext } from "../bootstrap/inspect.ts";
import { getMeta, INDEX_FILENAME, openIndex } from "./index-db.ts";
import { LOCAL_DIRECTORY } from "./layout.ts";
import { Outbox } from "./outbox.ts";
import { incrementalSync, rebuildIndex, type ReindexStats } from "./reindex.ts";
import { BoardWriter, type ReplayOutcome } from "./writer.ts";

export const SERVER_LOCK_FILENAME = "server.lock";

export interface BoardHandle {
  boardRoot: string;
  localDirectory: string;
  db: DatabaseSync;
  /** How the index was brought up to date for this command. */
  refresh: { mode: "rebuilt" | "incremental"; reason: string; stats: ReindexStats };
  /**
   * Rebuilds the index and swaps this handle onto the new generation.
   *
   * The old database keeps serving reads until the new one is complete, then
   * the handle points at the new one and the old connection is closed. Nothing
   * caches `db`, so every caller picks up the swap on its next statement —
   * which is what stops readers and writers ending up on different databases
   * (설계 §3.7).
   */
  refreshIndex(): ReindexStats;
  close(): void;
}

export interface OpenBoardOptions {
  /** Force a full rebuild even when the index looks current. */
  rebuild?: boolean;
}

export interface WritableBoard {
  board: BoardHandle;
  writer: BoardWriter;
  outbox: Outbox;
  replay: ReplayOutcome;
  lock: BootstrapLock;
  close(): Promise<void>;
}

/**
 * Opens the board for writing, as the single writer (ADR-002).
 *
 * The lock is an OS advisory lock on `.local/server.lock`, so a crashed
 * process releases it without leaving anything to clean up, and a second
 * writer is refused rather than allowed to interleave.
 *
 * Unfinished outbox records are replayed before the writer accepts anything,
 * because applying a new write on top of a half-finished one would make the
 * compare-and-swap meaningless.
 */
export async function openBoardForWriting(
  cwd: string,
  options: OpenBoardOptions = {},
): Promise<WritableBoard> {
  const board = openBoard(cwd, options);
  let lock: BootstrapLock;

  try {
    lock = await acquireLock(path.join(board.localDirectory, SERVER_LOCK_FILENAME));
  } catch (error) {
    board.close();
    throw error;
  }

  const outbox = new Outbox(board.localDirectory);
  const writer = new BoardWriter(board, outbox);
  const replay = writer.replay();

  return {
    board,
    writer,
    outbox,
    replay,
    lock,
    close: async () => {
      outbox.close();
      board.close();
      await lock.release();
    },
  };
}

/**
 * Opens the board index, bringing it up to date first.
 *
 * Refreshing on open rather than trusting whatever is on disk is what makes
 * "edit the files directly" a supported workflow: any command run after an
 * external edit sees the edit, without a watcher having been running at the
 * time (design §3.5 handles the live case; this is the floor beneath it).
 */
export function openBoard(
  cwd: string,
  options: OpenBoardOptions = {},
): BoardHandle {
  const context = resolveRepositoryContext(cwd);
  if (!context) {
    throw new BootstrapError(
      "E_NOT_GIT_REPOSITORY",
      "The current directory is not inside a Git worktree.",
    );
  }

  const boardRoot = context.boardPath;
  if (!fs.existsSync(path.join(boardRoot, "config.yaml"))) {
    // An index that remembers files, next to a board directory that has none,
    // is not an uninitialised repository — it is a board whose worktree was
    // removed. Telling those apart matters because the advice is opposite:
    // `init` would start over, discarding nothing visible but losing the link
    // to the data branch that still holds everything (ADR-006).
    if (indexRemembersFiles(path.join(boardRoot, LOCAL_DIRECTORY))) {
      throw new BootstrapError(
        "E_WORKTREE_MISSING",
        `The board worktree at ${boardRoot} is gone, but its index still lists files.`,
        "The data is safe on the localjira/data branch. Run localjira repair-worktree " +
          "to check it out again — do not run init, which would start a new board.",
      );
    }
    throw new BootstrapError(
      "E_BOARD_NOT_INITIALIZED",
      `No board found at ${boardRoot}.`,
      "Run localjira init from the repository primary worktree.",
    );
  }

  const localDirectory = path.join(boardRoot, LOCAL_DIRECTORY);
  const opened = openIndex(localDirectory);

  if (opened.needsRebuild || options.rebuild) {
    const { db, stats } = rebuildIndex(boardRoot, localDirectory, opened.db);
    return handle(boardRoot, localDirectory, db, {
      mode: "rebuilt",
      reason: options.rebuild && !opened.needsRebuild ? "requested" : opened.reason,
      stats,
    });
  }

  const stats = incrementalSync(boardRoot, opened.db);
  return handle(boardRoot, localDirectory, opened.db, {
    mode: "incremental",
    reason: "ok",
    stats,
  });
}

/**
 * True when the index still lists board files.
 *
 * Read directly rather than through `openIndex` because opening would migrate
 * or rebuild, and rebuilding against an empty worktree is precisely the outcome
 * this check exists to prevent.
 */
function indexRemembersFiles(localDirectory: string): boolean {
  const indexPath = path.join(localDirectory, INDEX_FILENAME);
  if (!fs.existsSync(indexPath)) {
    return false;
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(indexPath, { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) c FROM file_state").get() as { c: number };
    return row.c > 0;
  } catch {
    // Unreadable or too old to have the table: it cannot be evidence either way.
    return false;
  } finally {
    db?.close();
  }
}

function handle(
  boardRoot: string,
  localDirectory: string,
  db: DatabaseSync,
  refresh: BoardHandle["refresh"],
): BoardHandle {
  const board: BoardHandle = {
    boardRoot,
    localDirectory,
    db,
    refresh,
    refreshIndex: () => {
      const previous = board.db;
      const built = rebuildIndex(boardRoot, localDirectory, previous);
      board.db = built.db;
      board.refresh = { mode: "rebuilt", reason: "requested", stats: built.stats };
      return built.stats;
    },
    close: () => board.db.close(),
  };
  return board;
}

export interface IndexStatus {
  boardPath: string;
  boardId: string | null;
  schemaVersion: string | null;
  lastRebuildAt: string | null;
  counts: Record<string, number>;
  errors: Array<{ path: string; reason: string; detail: string | null }>;
  refresh: BoardHandle["refresh"];
}

export function indexStatus(board: BoardHandle): IndexStatus {
  const counts: Record<string, number> = {};
  for (const [label, sql] of [
    ["projects", "SELECT COUNT(*) c FROM projects"],
    ["issues", "SELECT COUNT(*) c FROM issues WHERE state='OK'"],
    ["sprints", "SELECT COUNT(*) c FROM sprints"],
    ["comments", "SELECT COUNT(*) c FROM comments WHERE deleted=0"],
    ["runs", "SELECT COUNT(*) c FROM runs"],
    ["events", "SELECT COUNT(*) c FROM events"],
    ["files", "SELECT COUNT(*) c FROM file_state"],
  ] as const) {
    counts[label] = Number((board.db.prepare(sql).get() as { c: number }).c);
  }

  const errors = (
    board.db
      .prepare("SELECT path, reason, detail FROM index_errors ORDER BY path")
      .all() as Array<{ path: string; reason: string; detail: string | null }>
  ).map((row) => ({ path: row.path, reason: row.reason, detail: row.detail ?? null }));

  const rebuiltAt = getMeta(board.db, "last_full_rebuild_at");

  return {
    boardPath: board.boardRoot,
    boardId: getMeta(board.db, "board_id") ?? boardConfig(board, "board_id"),
    schemaVersion: getMeta(board.db, "schema_version"),
    lastRebuildAt: rebuiltAt === null ? null : new Date(Number(rebuiltAt)).toISOString(),
    counts,
    errors,
    refresh: board.refresh,
  };
}

function boardConfig(board: BoardHandle, key: string): string | null {
  const row = board.db
    .prepare("SELECT v FROM board_config WHERE k = ?")
    .get(key) as { v?: string } | undefined;
  return row?.v ?? null;
}

export interface IssueSummary {
  key: string;
  uid: string;
  project: string;
  type: string | null;
  status: string | null;
  title: string | null;
  points: number | null;
  assignee: string | null;
  sprint: string | null;
  createdByKind: string | null;
  labels: string[];
}

export interface ListIssuesOptions {
  project?: string;
  /** Repeated values are alternatives; different fields are all required. */
  status?: string[];
  type?: string[];
  assignee?: string[];
  label?: string[];
  sprint?: string[];
  /** Excludes issues held up by an unfinished blocker (r02b). */
  claimable?: boolean;
  limit?: number;
  /** Free text over title, body, acceptance and key aliases. */
  q?: string;
  /** `(backlog_rank, uid)` of the last row of the previous page. */
  after?: { rank: string | null; uid: string } | null;
}

/** The shortest term trigram can match. Below this it returns nothing at all. */
export const MIN_TRIGRAM_TERM = 3;

export interface IssuePage {
  issues: IssueSummary[];
  hasMore: boolean;
  nextAfter: { rank: string | null; uid: string } | null;
}

/**
 * Lists issues under structured filters.
 *
 * Repeated values of one parameter are alternatives (`status=TODO&status=DONE`
 * means either), and different parameters all have to hold. One rule for every
 * field, because a filter that means AND for labels and OR for statuses is a
 * filter people have to test to believe.
 *
 * Paged by `(backlog_rank, uid)` rather than by offset. The list reorders —
 * that is its whole purpose — and an offset into a list that moved skips some
 * rows and repeats others without saying so.
 */
export function listIssues(
  board: BoardHandle,
  options: ListIssuesOptions = {},
): IssuePage {
  const where: string[] = ["i.state = 'OK'"];
  const params: unknown[] = [];

  const anyOf = (column: string, values: string[] | undefined): void => {
    if (!values || values.length === 0) {
      return;
    }
    where.push(`${column} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };

  if (options.project) {
    where.push("i.project = ?");
    params.push(options.project);
  }
  anyOf("i.status", options.status?.map((value) => value.toUpperCase()));
  anyOf("i.type", options.type?.map((value) => value.toLowerCase()));
  anyOf("i.assignee_id", options.assignee);
  anyOf("i.sprint_id", options.sprint);

  if (options.label && options.label.length > 0) {
    where.push(
      `EXISTS (SELECT 1 FROM issue_labels l WHERE l.uid = i.uid
                AND l.label IN (${options.label.map(() => "?").join(",")}))`,
    );
    params.push(...options.label);
  }

  if (options.claimable === true) {
    // An unfinished blocker is one declared from either side: `X blocked_by Y`
    // on X, or `Y blocks X` on Y. Both mean the same relation (S1-D4), so both
    // have to be looked at or half the blockers would be invisible here.
    where.push(
      `NOT EXISTS (
         SELECT 1 FROM issue_links k JOIN issues b ON b.uid = k.to_uid
          WHERE k.from_uid = i.uid AND k.kind = 'blocked_by'
            AND b.state = 'OK' AND b.status NOT IN ('DONE','CANCELLED')
       ) AND NOT EXISTS (
         SELECT 1 FROM issue_links k JOIN issues b ON b.uid = k.from_uid
          WHERE k.to_uid = i.uid AND k.kind = 'blocks'
            AND b.state = 'OK' AND b.status NOT IN ('DONE','CANCELLED')
       )`,
    );
  }

  if (options.q && options.q.trim() !== "") {
    where.push(searchClause(options.q, params));
  }

  if (options.after) {
    // Strictly after the cursor in the same order the rows come back in.
    where.push(
      `(COALESCE(i.backlog_rank, char(255)) > COALESCE(?, char(255))
        OR (COALESCE(i.backlog_rank, char(255)) = COALESCE(?, char(255)) AND i.uid > ?))`,
    );
    params.push(options.after.rank, options.after.rank, options.after.uid);
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const rows = board.db
    .prepare(
      `SELECT i.path, i.uid, i.project, i.key, i.type, i.status, i.title, i.points,
              i.assignee_id, i.sprint_id, i.backlog_rank, i.created_by_kind
         FROM issues i
        WHERE ${where.join(" AND ")}
        ORDER BY i.backlog_rank, i.uid
        LIMIT ?`,
    )
    .all(...params, limit + 1) as Array<Record<string, string | number | null>>;

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return {
    issues: page.map((row) => ({
      key: String(row.key),
      uid: String(row.uid),
      project: String(row.project),
      type: row.type as string | null,
      status: row.status as string | null,
      title: row.title as string | null,
      points: row.points as number | null,
      assignee: row.assignee_id as string | null,
      sprint: row.sprint_id as string | null,
      // Carried alongside the last actor, never instead of it: one says who made
      // the issue and never changes, the other says who touched it last (§5.1).
      createdByKind: row.created_by_kind as string | null,
      labels: labelsOf(board, String(row.path)),
    })),
    hasMore,
    nextAfter: hasMore && last
      ? { rank: (last.backlog_rank as string | null) ?? null, uid: String(last.uid) }
      : null,
  };
}

/**
 * Restricts the result set to what matches the query.
 *
 * Trigram is the tokenizer (S2-D2) because Korean attaches particles to the
 * word, so whitespace tokenizing finds fewer than half the real matches. Its
 * one limitation is that a term shorter than three characters matches *nothing*
 * — silently, with no error — so a two-letter search would look like an empty
 * board. Those fall back to LIKE, which is a scan the 5,000-row budget affords.
 */
function searchClause(query: string, params: unknown[]): string {
  const terms = query.trim().split(/\s+/).filter((term) => term !== "");
  const short = terms.some((term) => [...term].length < MIN_TRIGRAM_TERM);

  if (!short) {
    // Each term quoted so punctuation in a key like LJ-13 is not read as FTS
    // syntax; space-separated means all of them must appear.
    params.push(terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" "));
    return "i.uid IN (SELECT uid FROM issues_fts WHERE issues_fts MATCH ?)";
  }

  const clauses: string[] = [];
  for (const term of terms) {
    const like = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
    clauses.push(
      `(i.title LIKE ? ESCAPE '\\' OR i.resource_json LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM issue_former_keys f WHERE f.uid = i.uid AND f.key LIKE ? ESCAPE '\\'))`,
    );
    params.push(like, like, like);
  }
  return `(${clauses.join(" AND ")})`;
}

function labelsOf(board: BoardHandle, issuePath: string): string[] {
  return (
    board.db
      .prepare("SELECT label FROM issue_labels WHERE path = ? ORDER BY label")
      .all(issuePath) as Array<{ label: string }>
  ).map((row) => row.label);
}

export interface IssueDetail extends IssueSummary {
  etag: string;
  resource: unknown;
  path: string;
}

/**
 * Looks up by current key, then by a former key.
 *
 * A rekeyed issue must stay reachable by the key someone remembers or wrote in
 * a commit trailer (D3). An ambiguous former key returns nothing rather than a
 * guess — picking one would attach the wrong history to the wrong issue.
 */
export function findIssue(
  board: BoardHandle,
  key: string,
): { issue: IssueDetail } | { ambiguous: string[] } | null {
  const direct = board.db
    .prepare(
      `SELECT path, uid, project, key, type, status, title, points, assignee_id,
              sprint_id, etag, resource_json
         FROM issues WHERE key = ? AND state='OK'`,
    )
    .all(key) as Array<Record<string, string | number | null>>;

  if (direct.length === 1) {
    return { issue: toDetail(board, direct[0]) };
  }
  if (direct.length > 1) {
    return { ambiguous: direct.map((row) => String(row.uid)) };
  }

  const aliases = board.db
    .prepare(
      `SELECT i.path, i.uid, i.project, i.key, i.type, i.status, i.title, i.points,
              i.assignee_id, i.sprint_id, i.etag, i.resource_json
         FROM issue_former_keys f JOIN issues i ON i.path = f.path
        WHERE f.key = ? AND i.state='OK'`,
    )
    .all(key) as Array<Record<string, string | number | null>>;

  if (aliases.length === 1) {
    return { issue: toDetail(board, aliases[0]) };
  }
  if (aliases.length > 1) {
    return { ambiguous: aliases.map((row) => String(row.uid)) };
  }
  return null;
}

/**
 * Quarantined files that also claim this key.
 *
 * `findIssue` answers with the one readable claimant, which is the only answer
 * it can give — a file the parser rejected cannot be served. But when a broken
 * file holds the same key, that answer is one issue among two and saying so is
 * the difference between "here is LJ-2" and "here is the LJ-2 we can read".
 *
 * Reachable two ways: a row still marked INVALID from before the file broke,
 * and, after a full rebuild, only the error log — a file that never parsed
 * leaves no row at all. Both are asked, because which one exists depends on
 * whether anybody happened to rebuild.
 */
export function contestedBy(board: BoardHandle, key: string): string[] {
  const rows = board.db
    .prepare("SELECT path FROM issues WHERE key = ? AND state = 'INVALID'")
    .all(key) as Array<{ path: string }>;

  const project = /^([^-]+)-/.exec(key)?.[1] ?? "";
  const orphans = board.db
    .prepare("SELECT path FROM index_errors WHERE path = ?")
    .all(`issues/${project}/${key}.md`) as Array<{ path: string }>;

  return [...new Set([...rows, ...orphans].map((row) => row.path))].sort();
}

function toDetail(
  board: BoardHandle,
  row: Record<string, string | number | null>,
): IssueDetail {
  return {
    key: String(row.key),
    uid: String(row.uid),
    project: String(row.project),
    type: row.type as string | null,
    status: row.status as string | null,
    title: row.title as string | null,
    points: row.points as number | null,
    assignee: row.assignee_id as string | null,
    sprint: row.sprint_id as string | null,
    labels: labelsOf(board, String(row.path)),
    etag: String(row.etag),
    resource: JSON.parse(String(row.resource_json)),
    path: String(row.path),
  };
}
