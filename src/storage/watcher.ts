import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { LOCAL_DIRECTORY } from "./layout.ts";

export const DEBOUNCE_MS = 300;

/**
 * Events in one window past which the batch stops being worth trusting.
 *
 * A person saving files by hand does not get near this; a `git checkout` blows
 * past it instantly. At that point the cheaper and more honest move is to stop
 * pretending the event list is complete and reconcile the whole board
 * (design §3.5).
 */
export const OVERFLOW_EVENTS = 200;

/** Files whose change means git rewrote the tree underneath us. */
const GIT_SIGNALS = new Set(["HEAD", "index", "MERGE_HEAD"]);

/** Why a batch must be promoted from an incremental pass to a full one. */
export type Escalation = "watcher_overflow" | "git_head_change";

export interface WatchOptions {
  /** Coalescing window. Editors emit many events for one save. */
  debounceMs?: number;
  overflowEvents?: number;
  onBatch(paths: string[], escalation: Escalation | null): void;
  onError?(error: Error): void;
}

export interface BoardWatcher {
  readonly watching: boolean;
  /** Runs any pending batch now instead of waiting for the timer. */
  flush(): void;
  close(): void;
}

/**
 * Watches the board for changes made outside the API.
 *
 * The watcher is a *hint*. Everything it reports is re-scanned from disk
 * anyway, and the same reconciliation runs on startup and on demand, so a
 * platform where events are missed or coalesced still converges — it just
 * converges later (design §3.5).
 *
 * `.local/` is excluded: the index and outbox live there and change on every
 * write, so watching them would turn each write into a self-inflicted event
 * storm.
 */
export function watchBoard(boardRoot: string, options: WatchOptions): BoardWatcher {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const overflowEvents = options.overflowEvents ?? OVERFLOW_EVENTS;
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let escalation: Escalation | null = null;
  let eventsInWindow = 0;

  const watchers: fs.FSWatcher[] = [];

  const fire = (): void => {
    timer = null;
    if (pending.size === 0 && escalation === null) {
      return;
    }
    const batch = [...pending];
    const promoted = escalation;
    pending.clear();
    escalation = null;
    eventsInWindow = 0;
    try {
      options.onBatch(batch, promoted);
    } catch (error) {
      options.onError?.(error as Error);
    }
  };

  const escalate = (reason: Escalation): void => {
    // git wins: it says *why* the tree changed, which is the more useful
    // reason to log, and it implies the overflow anyway.
    if (escalation === null || reason === "git_head_change") {
      escalation = reason;
    }
  };

  const record = (relative: string | null): void => {
    if (closed) {
      return;
    }
    eventsInWindow += 1;
    if (eventsInWindow > overflowEvents) {
      escalate("watcher_overflow");
    }
    if (relative !== null) {
      pending.add(relative);
      if (isDirectory(path.join(boardRoot, relative))) {
        // A directory event means everything under it may have moved, and the
        // individual files usually do not get their own events.
        escalate("watcher_overflow");
      }
    }
    // Restarting the timer on every event is what makes twenty events from one
    // editor save collapse into a single reconciliation.
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(fire, debounceMs);
    timer.unref?.();
  };

  const handler = (_event: string, filename: string | Buffer | null): void => {
    if (filename === null) {
      // The platform lost track of which file changed. Nothing in the batch can
      // be trusted to be the whole story, so scan everything.
      escalate("watcher_overflow");
      record("");
      return;
    }
    const relative = filename.toString().split(path.sep).join("/");
    if (relative.startsWith(`${LOCAL_DIRECTORY}/`) || relative === LOCAL_DIRECTORY) {
      return;
    }
    record(relative);
  };

  const onWatcherError = (error: Error): void => {
    // ENOSPC, EMFILE, IN_Q_OVERFLOW: from here on the event stream has holes,
    // and waiting for a count threshold to notice would be waiting for nothing.
    escalate("watcher_overflow");
    record(null);
    options.onError?.(error);
  };

  // git rewrites the tree without touching it the way an editor does, so the
  // board's own events arrive late, partially, or as a flood. HEAD and index
  // move first, which makes them the earliest signal that a reconcile is due.
  for (const directory of gitSignalDirectories(boardRoot)) {
    try {
      const watcher = fs.watch(directory, (_event, filename) => {
        const name = filename === null ? "" : path.basename(filename.toString());
        if (name === "" || GIT_SIGNALS.has(name)) {
          escalate("git_head_change");
          record(null);
        }
      });
      watcher.on("error", (error) => options.onError?.(error as Error));
      watchers.push(watcher);
    } catch (error) {
      options.onError?.(error as Error);
    }
  }

  try {
    const watcher = fs.watch(boardRoot, { recursive: true }, handler);
    watcher.on("error", (error) => onWatcherError(error as Error));
    watchers.push(watcher);
  } catch (error) {
    // Recursive watching is not available everywhere; fall back to one watcher
    // per directory rather than silently watching nothing.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" && code !== "ENOTSUP") {
      throw error;
    }
    for (const directory of directoriesOf(boardRoot)) {
      try {
        const watcher = fs.watch(directory, (event, filename) => {
          const prefix = path.relative(boardRoot, directory);
          handler(event, filename === null ? null : path.join(prefix, filename.toString()));
        });
        watcher.on("error", (watchError) => onWatcherError(watchError as Error));
        watchers.push(watcher);
      } catch (watchError) {
        options.onError?.(watchError as Error);
      }
    }
  }

  return {
    get watching() {
      return !closed && watchers.length > 0;
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
      }
      fire();
    },
    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const watcher of watchers) {
        watcher.close();
      }
      watchers.length = 0;
    },
  };
}

function directoriesOf(root: string): string[] {
  const found: string[] = [root];

  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === LOCAL_DIRECTORY || entry.name === ".git") {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      found.push(absolute);
      walk(absolute);
    }
  };

  walk(root);
  return found;
}

function isDirectory(absolute: string): boolean {
  try {
    return fs.statSync(absolute).isDirectory();
  } catch {
    // Already gone. A deleted directory reports through its parent anyway.
    return false;
  }
}

/**
 * The directories holding `HEAD`, `index` and `MERGE_HEAD` for this board.
 *
 * Watched as directories rather than as files because `MERGE_HEAD` only exists
 * during a merge — watching the path directly would fail before it appears,
 * which is exactly when it matters.
 *
 * The paths have to come from git itself: `.localjira/` is a linked worktree,
 * so its `.git` is a *file* pointing at the real gitdir, and `HEAD` and `index`
 * do not live in the same place (ADR-006).
 */
function gitSignalDirectories(boardRoot: string): string[] {
  const found = new Set<string>();

  for (const name of GIT_SIGNALS) {
    const result = spawnSync("git", ["-C", boardRoot, "rev-parse", "--git-path", name], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      continue;
    }
    const resolved = result.stdout.trim();
    if (resolved === "") {
      continue;
    }
    const absolute = path.isAbsolute(resolved) ? resolved : path.join(boardRoot, resolved);
    const directory = path.dirname(absolute);
    if (fs.existsSync(directory)) {
      found.add(directory);
    }
  }
  return [...found];
}
