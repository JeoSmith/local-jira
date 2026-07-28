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
  return {
    boardRoot,
    localDirectory,
    db,
    refresh,
    close: () => db.close(),
  };
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
  labels: string[];
}

export interface ListIssuesOptions {
  project?: string;
  status?: string;
  limit?: number;
}

export function listIssues(
  board: BoardHandle,
  options: ListIssuesOptions = {},
): IssueSummary[] {
  const where: string[] = ["state = 'OK'"];
  const params: unknown[] = [];

  if (options.project) {
    where.push("project = ?");
    params.push(options.project);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status.toUpperCase());
  }

  const rows = board.db
    .prepare(
      `SELECT path, uid, project, key, type, status, title, points, assignee_id, sprint_id
         FROM issues
        WHERE ${where.join(" AND ")}
        ORDER BY backlog_rank, uid
        LIMIT ?`,
    )
    .all(...params, options.limit ?? 50) as Array<Record<string, string | number | null>>;

  return rows.map((row) => ({
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
  }));
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
