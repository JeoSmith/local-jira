import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

import type { Worktree } from "./model.ts";

export class GitCommandError extends Error {
  readonly args: string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    cwd: string,
    args: string[],
    exitCode: number | null,
    stderr: string,
  ) {
    super(stderr || `git ${args.join(" ")} failed`);
    this.name = "GitCommandError";
    this.args = args;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export function runGit(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): { ok: boolean; stdout: string; stderr: string; exitCode: number | null } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = result.stdout?.trimEnd() ?? "";
  const stderr = result.stderr?.trimEnd() ?? "";
  const exitCode = result.status;
  const ok = result.error == null && exitCode === 0;

  if (!ok && !options.allowFailure) {
    if (result.error) {
      throw result.error;
    }
    throw new GitCommandError(cwd, args, exitCode, stderr);
  }

  return { ok, stdout, stderr, exitCode };
}

export function resolveCurrentRoot(cwd: string): string | null {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  return result.ok ? canonicalPath(result.stdout) : null;
}

export function resolveGitCommonDir(cwd: string): string | null {
  const result = runGit(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { allowFailure: true },
  );
  return result.ok ? canonicalPath(result.stdout) : null;
}

export function listWorktrees(cwd: string): Worktree[] {
  const output = runGit(cwd, ["worktree", "list", "--porcelain"]).stdout;
  const records = output.split(/\n\n+/).filter(Boolean);

  return records.map((record) => {
    const worktree: Worktree = {
      path: "",
      head: null,
      branch: null,
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
    };

    for (const line of record.split("\n")) {
      const separator = line.indexOf(" ");
      const key = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1);

      switch (key) {
        case "worktree":
          worktree.path = canonicalPath(value);
          break;
        case "HEAD":
          worktree.head = value;
          break;
        case "branch":
          worktree.branch = value;
          break;
        case "bare":
          worktree.bare = true;
          break;
        case "detached":
          worktree.detached = true;
          break;
        case "locked":
          worktree.locked = true;
          break;
        case "prunable":
          worktree.prunable = true;
          break;
      }
    }

    return worktree;
  });
}

export function refExists(cwd: string, ref: string): boolean {
  return runGit(cwd, ["show-ref", "--verify", "--quiet", ref], {
    allowFailure: true,
  }).ok;
}

export function canonicalPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}
