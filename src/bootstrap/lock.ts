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
  release(): void;
}

export function bootstrapLockPath(gitCommonDir: string): string {
  return path.join(gitCommonDir, BOOTSTRAP_LOCK_FILENAME);
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
): Promise<BootstrapLock> {
  const lockPath = bootstrapLockPath(gitCommonDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  if (BSD_PLATFORMS.has(process.platform)) {
    return acquireWithOpenExlock(lockPath);
  }
  if (process.platform === "linux") {
    return acquireWithFlockHelper(lockPath);
  }
  throw new BootstrapLockUnsupportedError(process.platform);
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

  release(): void {
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
    fd = fs.openSync(lockPath, flags, 0o600);
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

  release(): void {
    if (this.#child === null) {
      return;
    }
    const child = this.#child;
    this.#child = null;
    // Closing stdin ends the helper's `cat`, which makes flock exit and the
    // kernel drop the lock. kill() is the fallback if it ignores EOF.
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

/**
 * Linux has `flock(2)` but Node exposes no binding for it, so the lock is held
 * by a child process instead: `flock` takes the lock, then execs a command that
 * blocks on stdin. The parent keeps that stdin open. If the parent dies, the
 * pipe closes, the command exits, and the kernel releases the lock — the same
 * crash behaviour as the BSD path.
 */
function acquireWithFlockHelper(lockPath: string): Promise<BootstrapLock> {
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

    child.once("exit", (code) => {
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

function isContentionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EACCES";
}
