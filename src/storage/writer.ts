import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import type { BoardHandle } from "./board.ts";
import { Outbox, type OutboxRecord, type Stage } from "./outbox.ts";
import { syncPath } from "./reindex.ts";
import { fileHash } from "./resource.ts";

/** Crash points for fault injection (design §9.4 / M1 test plan §3.1). */
export type CrashPoint =
  | "after_outbox"
  | "before_rename"
  | "after_rename"
  | "after_index"
  | "after_event";

export interface WriteRequest {
  kind: "create" | "update" | "delete" | "event";
  /** Board-relative path. */
  targetPath: string;
  /** Final bytes; null for a delete. */
  contents: string | null;
  /** Expected current file_hash, or null when the file must not exist. */
  expectedHash?: string | null;
  event?: {
    eventId: string;
    path: string;
    line: string;
  };
  actorId: string | null;
  actorKind: string;
}

export interface ReplayOutcome {
  replayed: number;
  rolledForward: number;
  aborted: number;
  /** Temp files left behind by a crashed write, removed on startup. */
  sweptTemporary: number;
}

export class WriteConflictError extends Error {
  readonly code = "E_WRITE_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "WriteConflictError";
  }
}

/**
 * The single writer.
 *
 * Every domain write goes through here so that the outbox, the atomic file
 * replacement, the index update and the event append happen in one known
 * order — and so that a crash anywhere in that order is recoverable by
 * replaying rather than by guessing what happened.
 */
export class BoardWriter {
  #board: BoardHandle;
  #outbox: Outbox;
  #queues = new Map<string, Promise<unknown>>();
  #replayed = false;

  constructor(board: BoardHandle, outbox: Outbox) {
    this.#board = board;
    this.#outbox = outbox;
  }

  get replayComplete(): boolean {
    return this.#replayed;
  }

  /**
   * Serialises writes per path.
   *
   * Two requests for the same file would otherwise interleave their
   * read-modify-write and lose one of the updates; different files are
   * independent and stay parallel.
   */
  async write(request: WriteRequest): Promise<void> {
    const previous = this.#queues.get(request.targetPath) ?? Promise.resolve();
    const next = previous.then(
      () => this.#writeNow(request),
      () => this.#writeNow(request),
    );
    this.#queues.set(
      request.targetPath,
      next.catch(() => undefined),
    );
    return next;
  }

  async #writeNow(request: WriteRequest): Promise<void> {
    if (!this.#replayed) {
      throw new WriteConflictError(
        "The outbox has not finished replaying; domain writes are not accepted yet.",
      );
    }

    const absolute = path.join(this.#board.boardRoot, request.targetPath);
    const current = request.kind === "event" ? null : readHash(absolute);

    if (request.expectedHash !== undefined && current !== request.expectedHash) {
      throw new WriteConflictError(
        `${request.targetPath} changed underneath this write`,
      );
    }

    const payload = request.contents === null ? null : Buffer.from(request.contents, "utf8");
    const record = this.#outbox.begin({
      kind: request.kind,
      targetPath: request.targetPath,
      beforeHash: current,
      resultHash: payload === null ? null : fileHash(payload),
      payload,
      eventPath: request.event?.path ?? null,
      eventId: request.event?.eventId ?? null,
      eventPayload: request.event?.line ?? null,
      actorId: request.actorId,
      actorKind: request.actorKind,
    });
    crashPoint("after_outbox");

    this.#applyFrom(record, "PENDING", false);
  }

  /**
   * Finishes an operation from whichever stage it reached.
   *
   * The same code runs for a fresh write and for a replay; only `checkEvent`
   * differs, because on the normal path the event cannot already be there and
   * scanning for it every time would cost a file read per write.
   */
  #applyFrom(record: OutboxRecord, from: Stage, checkEvent: boolean): void {
    const absolute = path.join(this.#board.boardRoot, record.targetPath);
    let stage = from;

    if (stage === "PENDING") {
      // An `event` op has no target file: the change it describes already
      // happened outside the API, and this only records that it did.
      if (record.kind !== "event") {
        if (record.payload === null) {
          fs.rmSync(absolute, { force: true });
        } else {
          writeFileAtomic(absolute, record.payload);
        }
      }
      this.#outbox.advance(record.seq, "FILE_DONE");
      stage = "FILE_DONE";
      crashPoint("after_rename");
    }

    if (stage === "FILE_DONE") {
      if (record.kind !== "event") {
        syncPath(this.#board.boardRoot, this.#board.db, record.targetPath);
      }
      this.#outbox.advance(record.seq, "INDEX_DONE");
      stage = "INDEX_DONE";
      crashPoint("after_index");
    }

    if (stage === "INDEX_DONE") {
      if (record.eventPath && record.eventPayload && record.eventId) {
        const eventFile = path.join(this.#board.boardRoot, record.eventPath);
        if (!checkEvent || !containsEventId(eventFile, record.eventId)) {
          appendLine(eventFile, record.eventPayload);
        }
        syncPath(this.#board.boardRoot, this.#board.db, record.eventPath);
      }
      this.#outbox.advance(record.seq, "EVENT_DONE");
      stage = "EVENT_DONE";
      crashPoint("after_event");
    }

    this.#outbox.advance(record.seq, "DONE");
  }

  /**
   * Rolls unfinished writes forward, or gives up on them without overwriting.
   *
   * The third branch is the one that matters: if the file on disk matches
   * neither the before nor the result hash, somebody edited it after the
   * crash. Rolling forward would erase that edit, so the record is abandoned
   * and the file's current content is indexed instead.
   */
  replay(): ReplayOutcome {
    const outcome: ReplayOutcome = { replayed: 0, rolledForward: 0, aborted: 0, sweptTemporary: 0 };

    // A process that aborts mid-write cannot run its own cleanup, so the
    // leftover temp file is swept here instead. Left alone it is inert but it
    // shows up as untracked in git, which makes a clean board look dirty.
    outcome.sweptTemporary = sweepTemporaryFiles(this.#board.boardRoot);

    for (const record of this.#outbox.pending()) {
      outcome.replayed += 1;
      if (record.kind === "event") {
        // Nothing to compare: replaying only re-appends the event, and the
        // event_id check keeps that from duplicating.
        this.#applyFrom(record, laterOf(record.stage), true);
        outcome.rolledForward += 1;
        continue;
      }

      const absolute = path.join(this.#board.boardRoot, record.targetPath);
      const current = readHash(absolute);

      if (current === record.beforeHash) {
        this.#applyFrom(record, "PENDING", true);
        outcome.rolledForward += 1;
        continue;
      }
      if (current === record.resultHash) {
        // The file landed; carry on from wherever the stage says we stopped.
        this.#applyFrom(record, laterOf(record.stage), true);
        continue;
      }

      this.#outbox.abort(
        record.seq,
        `The file changed after the crash (hash ${current ?? "absent"}); not overwriting.`,
      );
      syncPath(this.#board.boardRoot, this.#board.db, record.targetPath);
      outcome.aborted += 1;
    }

    this.#replayed = true;
    return outcome;
  }
}

/** PENDING means the file step is done but nothing after it. */
function laterOf(stage: Stage): Stage {
  return stage === "PENDING" ? "FILE_DONE" : stage;
}

/** Matches the temp name writeFileAtomic uses: `.<name>.<pid>.tmp`. */
const TEMPORARY = /^\..+\.\d+\.tmp$/;

function sweepTemporaryFiles(boardRoot: string): number {
  let removed = 0;

  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // `.local/` holds live databases, never these temp files.
        if (entry.name !== ".local" && entry.name !== ".git") {
          walk(absolute);
        }
        continue;
      }
      if (entry.isFile() && TEMPORARY.test(entry.name)) {
        fs.rmSync(absolute, { force: true });
        removed += 1;
      }
    }
  };

  walk(boardRoot);
  return removed;
}

function readHash(absolute: string): string | null {
  try {
    return fileHash(fs.readFileSync(absolute));
  } catch {
    return null;
  }
}

/**
 * temp → fsync → rename → fsync(parent), with the temp file in the *same*
 * directory so the rename cannot cross a filesystem and stop being atomic.
 */
export function writeFileAtomic(target: string, contents: Buffer): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.tmp`);

  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, "w", 0o644);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    crashPoint("before_rename");
    fs.renameSync(temporary, target);
    syncDirectory(directory);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The original error is the one worth reporting.
      }
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Appends one line, then fsyncs.
 *
 * A single write of a line that ends in a newline is what keeps a crash from
 * leaving half a record; readers additionally drop an unterminated final line,
 * so both sides of the contract hold.
 */
function appendLine(target: string, line: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, "a", 0o644);
  try {
    fs.writeSync(fd, `${line.replace(/\n+$/, "")}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function containsEventId(target: string, eventId: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      if ((JSON.parse(line) as { event_id?: string }).event_id === eventId) {
        return true;
      }
    } catch {
      // A truncated trailing line is expected after a crash.
    }
  }
  return false;
}

function syncDirectory(directory: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch {
    // Unavailable on some filesystems; the rename itself is still atomic.
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

function crashPoint(point: CrashPoint): void {
  if (process.env.LOCALJIRA_WRITE_CRASH_AT === point) {
    // abort() rather than throw: a thrown error would unwind cleanly, which is
    // exactly what a real crash does not do.
    process.abort();
  }
}
