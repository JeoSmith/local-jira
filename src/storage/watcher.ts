import fs from "node:fs";
import path from "node:path";

import { LOCAL_DIRECTORY } from "./layout.ts";

export const DEBOUNCE_MS = 300;

export interface WatchOptions {
  /** Coalescing window. Editors emit many events for one save. */
  debounceMs?: number;
  onBatch(paths: string[]): void;
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
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const watchers: fs.FSWatcher[] = [];

  const fire = (): void => {
    timer = null;
    if (pending.size === 0) {
      return;
    }
    const batch = [...pending];
    pending.clear();
    try {
      options.onBatch(batch);
    } catch (error) {
      options.onError?.(error as Error);
    }
  };

  const record = (relative: string | null): void => {
    if (closed) {
      return;
    }
    if (relative !== null) {
      pending.add(relative);
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
      // The platform lost track of which file changed; reconcile broadly.
      record("");
      return;
    }
    const relative = filename.toString().split(path.sep).join("/");
    if (relative.startsWith(`${LOCAL_DIRECTORY}/`) || relative === LOCAL_DIRECTORY) {
      return;
    }
    record(relative);
  };

  try {
    const watcher = fs.watch(boardRoot, { recursive: true }, handler);
    watcher.on("error", (error) => options.onError?.(error as Error));
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
        watcher.on("error", (watchError) => options.onError?.(watchError as Error));
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
