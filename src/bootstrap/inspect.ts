import fs from "node:fs";
import path from "node:path";

import { canonicalPath, listWorktrees, refExists, runGit } from "./git.ts";
import { BOARD_DIRECTORY, DATA_BRANCH, DATA_BRANCH_REF } from "./model.ts";
import type {
  BoardPathState,
  BootstrapSnapshot,
  BranchRelation,
} from "./state.ts";

export const DEFAULT_REMOTE = "origin";

export interface SnapshotOptions {
  remote?: string;
  observedUnderLock?: boolean;
  remoteObservationFresh?: boolean;
}

export interface RepositoryContext {
  currentRoot: string;
  repoRoot: string;
  boardPath: string;
  isPrimaryWorktree: boolean;
}

export function remoteBranchRef(remote: string): string {
  return `refs/remotes/${remote}/${DATA_BRANCH}`;
}

export function resolveRepositoryContext(
  cwd: string,
): RepositoryContext | null {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  if (!result.ok) {
    return null;
  }

  const currentRoot = canonicalPath(result.stdout);
  const worktrees = listWorktrees(currentRoot);
  const repoRoot = worktrees[0]?.path ?? currentRoot;

  return {
    currentRoot,
    repoRoot,
    boardPath: path.join(repoRoot, BOARD_DIRECTORY),
    isPrimaryWorktree: currentRoot === repoRoot,
  };
}

export function buildSnapshot(
  context: RepositoryContext,
  options: SnapshotOptions = {},
): BootstrapSnapshot {
  const remote = options.remote ?? DEFAULT_REMOTE;
  const remoteConfigured = isRemoteConfigured(context.repoRoot, remote);
  const localBranchExists = refExists(context.repoRoot, DATA_BRANCH_REF);
  const remoteRef = remoteBranchRef(remote);
  const remoteBranchExists =
    remoteConfigured && refExists(context.repoRoot, remoteRef);

  const worktrees = listWorktrees(context.repoRoot);
  const canonicalBoardPath = canonicalPath(context.boardPath);
  const boardWorktree =
    worktrees.find((worktree) => worktree.path === canonicalBoardPath) ?? null;
  const dataBranchWorktree =
    worktrees.find((worktree) => worktree.branch === DATA_BRANCH_REF) ?? null;

  return {
    observedUnderLock: options.observedUnderLock ?? false,
    remoteObservationFresh: options.remoteObservationFresh ?? false,
    remoteConfigured,
    localBranchExists,
    remoteBranchExists,
    boardPathState: classifyBoardPath(context.boardPath, boardWorktree),
    boardWorktreeBranch: boardWorktree?.branch ?? null,
    dataBranchCheckoutPath: dataBranchWorktree?.path ?? null,
    boardPath: context.boardPath,
    branchRelation: classifyBranchRelation(
      context.repoRoot,
      localBranchExists,
      remoteBranchExists,
      remoteRef,
    ),
  };
}

export function isRemoteConfigured(repoRoot: string, remote: string): boolean {
  const result = runGit(repoRoot, ["remote"], { allowFailure: true });
  if (!result.ok) {
    return false;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .includes(remote);
}

function classifyBoardPath(
  boardPath: string,
  boardWorktree: { branch: string | null } | null,
): BoardPathState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(boardPath);
  } catch {
    return "absent";
  }

  if (stat.isSymbolicLink()) {
    return "symlink";
  }
  if (!stat.isDirectory()) {
    return "occupied";
  }
  if (!boardWorktree) {
    return "occupied";
  }
  return boardWorktree.branch === DATA_BRANCH_REF
    ? "correct_worktree"
    : "wrong_worktree";
}

/**
 * Ancestry only — never a timestamp or commit count.
 *
 * "diverged" is reported when neither side is an ancestor of the other, and
 * bootstrap refuses to merge or rebase because no reconciler exists yet to
 * validate the resulting board (design §4.1).
 */
function classifyBranchRelation(
  repoRoot: string,
  localBranchExists: boolean,
  remoteBranchExists: boolean,
  remoteRef: string,
): BranchRelation {
  if (!localBranchExists || !remoteBranchExists) {
    return "not_applicable";
  }

  const local = revParse(repoRoot, DATA_BRANCH_REF);
  const remote = revParse(repoRoot, remoteRef);
  if (!local || !remote) {
    return "not_applicable";
  }
  if (local === remote) {
    return "equal";
  }

  const localIsAncestor = isAncestor(repoRoot, local, remote);
  const remoteIsAncestor = isAncestor(repoRoot, remote, local);

  if (localIsAncestor) {
    return "local_behind";
  }
  if (remoteIsAncestor) {
    return "local_ahead";
  }
  return "diverged";
}

function revParse(repoRoot: string, ref: string): string | null {
  const result = runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`], {
    allowFailure: true,
  });
  return result.ok ? result.stdout.trim() : null;
}

function isAncestor(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): boolean {
  return runGit(
    repoRoot,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { allowFailure: true },
  ).ok;
}
