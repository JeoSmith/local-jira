import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const BOOTSTRAP_LOCK_FILENAME = "localjira-bootstrap.lock";

/**
 * BSD `O_EXLOCK`. Node does not expose this in `fs.constants`, so the numeric
 * value is inlined — but only for the BSD family, where `open(2)` defines it.
 *
 * Linux must never take this path. Its `open(2)` has no `O_EXLOCK`, and an
 * unrecognised bit is ignored rather than rejected, so the call would succeed
 * and hand back a descriptor that holds no lock at all. Silently running
 * unlocked is worse than refusing to run (ADR-002).
 */
const BSD_O_EXLOCK = 0x20;
const BSD_PLATFORMS = new Set(["darwin", "freebsd", "openbsd", "netbsd"]);

/** Distinguishes "could not lock" from an exit code of the helper's command. */
const FLOCK_CONFLICT_EXIT_CODE = 75;
const FLOCK_ACQUIRED_MARKER = "R";
/** How long a helper gets to exit on EOF before it is signalled. */
const FLOCK_EXIT_GRACE_MS = 2_000;
/** Owner-only: the lock file sits inside the git common dir. */
const LOCK_FILE_MODE = 0o600;

export type LockMechanism = "bsd_o_exlock" | "linux_flock_helper";

export class BootstrapBusyError extends Error {
  readonly code = "E_BOOTSTRAP_BUSY";
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(
      `Another localjira bootstrap command is already running (${lockPath}).`,
    );
    this.name = "BootstrapBusyError";
    this.lockPath = lockPath;
  }
}

export class BootstrapLockUnsupportedError extends Error {
  readonly code = "E_PLATFORM_UNSUPPORTED";
  readonly platform: string;

  constructor(platform: string) {
    super(
      `Advisory locking is not implemented for platform "${platform}". ` +
        "Supported platforms are macOS/BSD and Linux (OQ-M0-1).",
    );
    this.name = "BootstrapLockUnsupportedError";
    this.platform = platform;
  }
}

export interface BootstrapLock {
  readonly path: string;
  readonly mechanism: LockMechanism;
  readonly held: boolean;
  /**
   * Resolves once the lock is actually gone, not merely once release was asked
   * for. On Linux the lock lives in a child process, so releasing it is
   * inherently asynchronous — a caller that re-acquires without awaiting would
   * race its own helper and get E_BOOTSTRAP_BUSY. The BSD path resolves
   * immediately but keeps the same signature so callers need not branch.
   */
  release(): Promise<void>;
}

export function bootstrapLockPath(gitCommonDir: string): string {
  return path.join(gitCommonDir, BOOTSTRAP_LOCK_FILENAME);
}

/**
 * Takes an advisory lock on an arbitrary file.
 *
 * The bootstrap lock and the server's single-writer lock (ADR-002) need the
 * same platform handling and the same crash behaviour, so they share one
 * implementation rather than growing a second, less-tested copy.
 */
export async function acquireLock(
  lockPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<BootstrapLock> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  if (BSD_PLATFORMS.has(platform)) {
    return acquireWithOpenExlock(lockPath);
  }
  if (platform === "linux") {
    return acquireWithFlockHelper(lockPath);
  }
  throw new BootstrapLockUnsupportedError(platform);
}

export function isLockSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return BSD_PLATFORMS.has(platform) || platform === "linux";
}

/**
 * Holds an OS advisory lock for the lifetime of the process.
 *
 * The lock lives in the descriptor, not in the file: the kernel drops it when
 * the holding process dies, so a crashed bootstrap never leaves a lock that
 * someone has to clean up. Presence of the lock file means nothing, and it is
 * never deleted to signal release (ADR-002, design §3.2).
 */
export async function acquireBootstrapLock(
  gitCommonDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<BootstrapLock> {
  return acquireLock(bootstrapLockPath(gitCommonDir), platform);
}

class OpenExlockLock implements BootstrapLock {
  readonly path: string;
  readonly mechanism: LockMechanism = "bsd_o_exlock";
  #fd: number | null;

  constructor(lockPath: string, fd: number) {
    this.path = lockPath;
    this.#fd = fd;
  }

  get held(): boolean {
    return this.#fd !== null;
  }

  async release(): Promise<void> {
    if (this.#fd === null) {
      return;
    }
    const fd = this.#fd;
    this.#fd = null;
    fs.closeSync(fd);
  }
}

function acquireWithOpenExlock(lockPath: string): BootstrapLock {
  const flags =
    fs.constants.O_CREAT |
    fs.constants.O_RDWR |
    BSD_O_EXLOCK |
    fs.constants.O_NONBLOCK;

  let fd: number;
  try {
    fd = fs.openSync(lockPath, flags, LOCK_FILE_MODE);
  } catch (error) {
    if (isContentionError(error)) {
      throw new BootstrapBusyError(lockPath);
    }
    throw error;
  }

  return new OpenExlockLock(lockPath, fd);
}

class FlockHelperLock implements BootstrapLock {
  readonly path: string;
  readonly mechanism: LockMechanism = "linux_flock_helper";
  #child: ChildProcessWithoutNullStreams | null;

  constructor(lockPath: string, child: ChildProcessWithoutNullStreams) {
    this.path = lockPath;
    this.#child = child;
  }

  get held(): boolean {
    return this.#child !== null;
  }

  release(): Promise<void> {
    if (this.#child === null) {
      return Promise.resolve();
    }
    const child = this.#child;
    this.#child = null;

    return new Promise((resolve) => {
      // The helper was unref'd while idle; hold the loop open until it is gone,
      // otherwise the process could exit before the lock is actually released.
      //
      // All three handles, not just the process. "close" fires once the child
      // has exited *and* its pipes have drained, which are separate events, so
      // re-referencing the process alone leaves the gap between them unheld. A
      // loop with nothing else to do then exits with this promise pending — the
      // caller's `await` never settles and its `finally` never runs. Because
      // every git call in the bootstrap path is `spawnSync`, these two helper
      // promises are the *only* asynchrony in `localjira init`, which is why
      // the symptom was an unsettled top-level await pointing straight at it.
      child.ref();
      child.stdout.ref();
      child.stderr.ref();

      const fallback = setTimeout(
        () => child.kill("SIGKILL"),
        FLOCK_EXIT_GRACE_MS,
      );

      // "close" rather than "exit": it fires after the helper has exited *and*
      // its stdio has been drained, which is when the kernel has certainly
      // dropped the lock.
      child.once("close", () => {
        clearTimeout(fallback);
        resolve();
      });

      // Closing stdin ends the helper's `cat`, which makes flock exit. The
      // signal above is only a fallback for a helper that ignores EOF.
      child.stdin.end();
    });
  }
}

/**
 * Linux has `flock(2)` but Node exposes no binding for it, so the lock is held
 * by a child process instead: `flock` takes the lock, then execs a command that
 * blocks on stdin. The parent keeps that stdin open. If the parent dies, the
 * pipe closes, the command exits, and the kernel releases the lock — the same
 * crash behaviour as the BSD path.
 */
export function acquireWithFlockHelper(lockPath: string): Promise<BootstrapLock> {
  // flock(1) creates the file itself, under the runner's umask, so it would end
  // up world-readable. Create it here first with the mode the design asks for;
  // the BSD path gets this from open(2) directly.
  ensureLockFileMode(lockPath);

  return new Promise((resolve, reject) => {
    const child = spawn(
      "flock",
      [
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        String(FLOCK_CONFLICT_EXIT_CODE),
        lockPath,
        "sh",
        "-c",
        `printf %s ${FLOCK_ACQUIRED_MARKER}; exec cat`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    ) as ChildProcessWithoutNullStreams;

    let settled = false;
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.stdout.once("data", () => {
      if (settled) {
        return;
      }
      settled = true;
      // Do not keep the event loop alive just because the helper is running.
      child.unref();
      child.stdout.unref();
      child.stderr.unref();
      resolve(new FlockHelperLock(lockPath, child));
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });

    // "close" rather than "exit": exit can fire before stderr has been read,
    // which would drop the helper's own error message from the report and leave
    // the user with a bare exit code.
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (code === FLOCK_CONFLICT_EXIT_CODE) {
        reject(new BootstrapBusyError(lockPath));
        return;
      }
      reject(
        new Error(
          `flock helper exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}

function ensureLockFileMode(lockPath: string): void {
  try {
    fs.closeSync(
      fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_RDWR,
        LOCK_FILE_MODE,
      ),
    );
    fs.chmodSync(lockPath, LOCK_FILE_MODE);
  } catch {
    // A pre-existing file owned by another user cannot be chmod'd. The lock
    // still works; only the permission hardening is best effort.
  }
}

function isContentionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EACCES";
}
