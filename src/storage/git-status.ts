import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface PendingFile {
  path: string;
  /** `added` for untracked or staged-new, `modified`, `deleted`, `renamed`. */
  kind: "added" | "modified" | "deleted" | "renamed";
  /** The display key when the path is an issue file, so the list reads. */
  key: string | null;
}

export interface GitStatus {
  /** False when `.localjira/` is not a worktree — everything else is unknown. */
  available: boolean;
  reason: string | null;
  recovery: string | null;
  pending: PendingFile[];
  /** Commits made locally and not yet pushed. Committed is not backed up (D5). */
  ahead: number | null;
  /** When the remote-tracking ref last moved here. Approximate; see below. */
  lastPushAt: string | null;
  remote: string | null;
}

/**
 * What git makes of the board worktree.
 *
 * Only `.localjira/` — the code tree is a different repository state and
 * counting its changes would make the badge move when somebody edits source
 * (D1). Nothing here touches the network: N4 says the tool works offline, so
 * this reads local git data and never fetches.
 */
export function gitStatus(boardRoot: string, timezone: string | null = null): GitStatus {
  const unavailable = (reason: string, recovery: string | null = null): GitStatus => ({
    available: false,
    reason,
    recovery,
    pending: [],
    ahead: null,
    lastPushAt: null,
    remote: null,
  });

  if (!fs.existsSync(boardRoot)) {
    return unavailable(
      `${boardRoot} is missing.`,
      "git worktree add .localjira localjira/data",
    );
  }

  // `-uall` because git otherwise collapses a new directory to `?? issues/`,
  // and the first issue anybody creates lands in exactly such a directory —
  // the one case AC24 names would have counted a folder instead of a file.
  const porcelain = run(boardRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (porcelain === null) {
    // A failure here must not take the board down with it: the issues are
    // files, and they are readable whether or not git can talk about them.
    return unavailable(
      "git could not read the board worktree.",
      "Check that .localjira is a git worktree: git -C .localjira status",
    );
  }

  const pending = porcelain
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(toPendingFile);

  const remote = run(boardRoot, ["remote"])?.split("\n")[0]?.trim() || null;

  return {
    available: true,
    reason: null,
    recovery: null,
    pending,
    ahead: remote === null ? null : aheadCount(boardRoot),
    lastPushAt: remote === null ? null : lastPushAt(boardRoot, remote, timezone),
    remote,
  };
}

/**
 * Parses one porcelain line.
 *
 * Counted per file rather than per hunk, matching AC1's promise that creating
 * one issue shows up as one changed file. A hunk count would make that sentence
 * false the moment an edit touched two parts of a file.
 */
function toPendingFile(line: string): PendingFile {
  const code = line.slice(0, 2);
  const rest = line.slice(3);
  // A rename reads `R  old -> new`; the new name is the one worth showing.
  const filePath = code.startsWith("R") ? (rest.split(" -> ")[1] ?? rest) : rest;

  const kind: PendingFile["kind"] = code.startsWith("R")
    ? "renamed"
    : code.includes("D")
      ? "deleted"
      : code === "??" || code.includes("A")
        ? "added"
        : "modified";

  const issue = /^issues\/[^/]+\/([^/]+)\.md$/.exec(filePath.replace(/^"|"$/g, ""));
  return { path: filePath.replace(/^"|"$/g, ""), kind, key: issue?.[1] ?? null };
}

/** Commits that exist here and nowhere else yet. */
function aheadCount(boardRoot: string): number | null {
  const counted = run(boardRoot, ["rev-list", "--count", "@{upstream}..HEAD"]);
  if (counted === null) {
    return null;
  }
  const value = Number(counted.trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * When the remote-tracking ref last moved on this machine.
 *
 * An approximation, and worth naming as one: the server never observes a push,
 * so the closest local evidence is the reflog of `refs/remotes/<remote>/…`,
 * which moves on push and on fetch. Since N4 forbids fetching, a move here is
 * almost always a push. With no reflog the ref file's own mtime is the fallback.
 */
function lastPushAt(
  boardRoot: string,
  remote: string,
  timezone: string | null,
): string | null {
  const branch = run(boardRoot, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  if (!branch) {
    return null;
  }

  const logged = run(boardRoot, [
    "reflog", "show", "--date=iso-strict", "-n", "1", `${remote}/${branch}`,
  ]);
  const stamp = logged === null ? null : /\{([^}]+)\}/.exec(logged)?.[1];
  if (stamp) {
    return stamp;
  }

  const refPath = run(boardRoot, ["rev-parse", "--git-path", `refs/remotes/${remote}/${branch}`]);
  if (refPath === null) {
    return null;
  }
  const absolute = refPath.trim();
  const resolved = path.isAbsolute(absolute) ? absolute : path.join(boardRoot, absolute);
  try {
    void timezone;
    return new Date(fs.statSync(resolved).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function run(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}
