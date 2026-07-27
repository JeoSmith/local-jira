import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { runGit } from "./git.ts";
import {
  CODE_IGNORE_RULE,
  DATA_IGNORE_RULE,
  ensureIgnoreRule,
} from "./ignore.ts";
import type { ProjectInput } from "./input.ts";
import { DATA_BRANCH, DATA_BRANCH_REF } from "./model.ts";
import { remoteBranchRef } from "./inspect.ts";
import type { BootstrapAction, BootstrapPlan } from "./plan.ts";
import {
  ensureNodeIdentity,
  utcTimestamp,
  writeInitialScaffold,
} from "./scaffold.ts";

export const STRUCTURAL_COMMIT_MESSAGE = "chore(localjira): initialize board";

/** The failure contract of design §7.2, plus two preconditions it implies. */
export type BootstrapErrorCode =
  | "E_NOT_GIT_REPOSITORY"
  | "E_NOT_PRIMARY_WORKTREE"
  | "E_UNSAFE_BOARD_PATH"
  | "E_BOARD_PATH_OCCUPIED"
  | "E_BRANCH_CHECKED_OUT"
  | "E_WRONG_WORKTREE_BRANCH"
  | "E_DATA_BRANCH_DIVERGED"
  | "E_REMOTE_NOT_CONFIGURED"
  | "E_PROJECT_MISMATCH"
  | "E_PROJECT_NOT_FOUND"
  | "E_PUSH_FAILED"
  | "E_PARTIAL_BOOTSTRAP"
  | "E_NO_CODE_COMMIT"
  | "E_ORPHAN_WORKTREE_DIRTY"
  | "E_BOARD_NOT_INITIALIZED";

export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode;
  readonly recovery: string | null;

  constructor(
    code: BootstrapErrorCode,
    message: string,
    recovery: string | null = null,
  ) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
    this.recovery = recovery;
  }
}

export interface ExecuteOptions {
  repoRoot: string;
  boardPath: string;
  remote: string;
  push: boolean;
  project: ProjectInput;
  now?: string;
}

export interface ExecutionResult {
  actions: BootstrapAction[];
  warnings: string[];
  boardId: string | null;
  nodeId: string | null;
  codeIgnoreChanged: boolean;
}

interface ExecutionState {
  temporaryWorktree: string | null;
  createdBranch: boolean;
  createdWorktree: boolean;
  boardId: string | null;
  nodeId: string | null;
  codeIgnoreChanged: boolean;
  warnings: string[];
  completed: BootstrapAction[];
}

export function executePlan(
  plan: BootstrapPlan,
  options: ExecuteOptions,
): ExecutionResult {
  if (!plan.executable) {
    throw new BootstrapError(
      "E_PARTIAL_BOOTSTRAP",
      plan.blockedReason ?? "The bootstrap plan is not executable.",
    );
  }

  const state: ExecutionState = {
    temporaryWorktree: null,
    createdBranch: false,
    createdWorktree: false,
    boardId: null,
    nodeId: null,
    codeIgnoreChanged: false,
    warnings: [...plan.warnings],
    completed: [],
  };

  for (const action of plan.actions) {
    try {
      crashPointBefore(action);
      runAction(action, options, state);
      state.completed.push(action);
      crashPointAfter(action);
    } catch (error) {
      // A failed push leaves a perfectly good local board behind. Tearing it
      // down would destroy more than it protects (design §5.5).
      if (action === "push_data_branch") {
        throw asPushFailure(error);
      }
      rollback(plan, options, state, error);
      throw error;
    }
  }

  cleanupTemporaryWorktree(options, state);

  return {
    actions: state.completed,
    warnings: state.warnings,
    boardId: state.boardId,
    nodeId: state.nodeId,
    codeIgnoreChanged: state.codeIgnoreChanged,
  };
}

/**
 * Fault-injection hooks (design §9.4).
 *
 * `process.abort()` rather than a thrown error: a thrown error would run the
 * rollback path, which is precisely what a real crash does *not* do. These are
 * inert unless the environment variable names an action, and the variable is
 * only ever set by tests.
 */
function crashPointBefore(action: BootstrapAction): void {
  if (process.env.LOCALJIRA_CRASH_BEFORE === action) {
    process.abort();
  }
}

function crashPointAfter(action: BootstrapAction): void {
  if (process.env.LOCALJIRA_CRASH_AFTER === action) {
    process.abort();
  }
}

function runAction(
  action: BootstrapAction,
  options: ExecuteOptions,
  state: ExecutionState,
): void {
  switch (action) {
    case "acquire_bootstrap_lock":
    case "fetch_data_branch":
    case "reinspect_repository":
      // Preparation actions are driven by the command, which must re-observe
      // the repository and build a fresh plan before mutating anything.
      return;
    case "create_orphan_in_temporary_worktree":
      createOrphanWorktree(options, state);
      return;
    case "write_initial_scaffold":
      writeScaffold(options, state);
      return;
    case "ensure_data_ignore":
      ensureDataIgnore(options, state);
      return;
    case "create_structural_commit":
      createStructuralCommit(options, state);
      return;
    case "create_local_tracking_branch":
      createLocalTrackingBranch(options, state);
      return;
    case "fast_forward_local_branch":
      fastForwardLocalBranch(options);
      return;
    case "attach_board_worktree":
      attachBoardWorktree(options, state);
      return;
    case "verify_existing_project":
      verifyExistingProject(options);
      return;
    case "ensure_node_identity":
      ensureIdentity(options, state);
      return;
    case "ensure_code_ignore":
      ensureCodeIgnore(options, state);
      return;
    case "push_data_branch":
      pushDataBranch(options, state);
      return;
  }
}

/**
 * Creates the orphan branch without switching the user's code branch.
 *
 * A temporary worktree is attached at a detached HEAD, `switch --orphan` runs
 * inside it, and the result is published with `worktree move`. The user's
 * index and working tree are never touched (design §5.2).
 */
function createOrphanWorktree(
  options: ExecuteOptions,
  state: ExecutionState,
): void {
  const head = runGit(options.repoRoot, ["rev-parse", "--verify", "HEAD"], {
    allowFailure: true,
  });
  if (!head.ok) {
    throw new BootstrapError(
      "E_NO_CODE_COMMIT",
      "The repository has no commits yet, so a temporary worktree cannot be attached.",
      "Create at least one commit on the code branch, then run localjira init again.",
    );
  }

  const temporary = path.join(
    options.repoRoot,
    `.localjira.init-${process.pid}-${Date.now()}`,
  );

  runGit(options.repoRoot, ["worktree", "add", "--detach", temporary]);
  state.temporaryWorktree = temporary;

  runGit(temporary, ["switch", "--orphan", DATA_BRANCH]);
  state.createdBranch = true;

  const status = runGit(temporary, ["status", "--porcelain"]).stdout;
  if (status.trim() !== "") {
    throw new BootstrapError(
      "E_ORPHAN_WORKTREE_DIRTY",
      `The new orphan worktree is not empty:\n${status}`,
      "Inspect the repository state; Local Jira will not commit unexpected files.",
    );
  }
}

function writeScaffold(options: ExecuteOptions, state: ExecutionState): void {
  const target = state.temporaryWorktree ?? options.boardPath;
  const result = writeInitialScaffold(target, {
    ...options.project,
    createdAt: options.now ?? utcTimestamp(),
  });
  state.boardId = result.boardId;
}

function ensureDataIgnore(
  options: ExecuteOptions,
  state: ExecutionState,
): void {
  const target = state.temporaryWorktree ?? options.boardPath;
  if (!fs.existsSync(target)) {
    return;
  }

  const result = ensureIgnoreRule(path.join(target, ".gitignore"), DATA_IGNORE_RULE);
  if (result.changed && state.temporaryWorktree === null) {
    // On an existing board the rule is repaired but not committed; the board
    // owner decides when that lands (design §5.4).
    state.warnings.push(
      `Added ${DATA_IGNORE_RULE} to the board .gitignore. Commit it on ${DATA_BRANCH}.`,
    );
  }
}

function createStructuralCommit(
  options: ExecuteOptions,
  state: ExecutionState,
): void {
  const worktree = state.temporaryWorktree;
  if (!worktree) {
    throw new BootstrapError(
      "E_PARTIAL_BOOTSTRAP",
      "A structural commit was planned without a temporary worktree.",
    );
  }

  runGit(worktree, ["add", "--all"]);
  // The single exception to "the service never commits" (D4): an orphan branch
  // does not exist until it has a commit. Signing is disabled so a configured
  // but unusable signing key cannot block bootstrap.
  runGit(worktree, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--no-verify",
    "--message",
    STRUCTURAL_COMMIT_MESSAGE,
  ]);
}

function createLocalTrackingBranch(
  options: ExecuteOptions,
  state: ExecutionState,
): void {
  runGit(options.repoRoot, [
    "branch",
    "--track",
    DATA_BRANCH,
    remoteBranchRef(options.remote),
  ]);
  state.createdBranch = true;
}

function fastForwardLocalBranch(options: ExecuteOptions): void {
  const remoteRef = remoteBranchRef(options.remote);
  const attached = isBoardAttached(options);

  if (attached) {
    runGit(options.boardPath, ["merge", "--ff-only", remoteRef]);
    return;
  }
  // Safe because the plan only reaches here when local is an ancestor of remote.
  runGit(options.repoRoot, ["branch", "--force", DATA_BRANCH, remoteRef]);
}

function attachBoardWorktree(
  options: ExecuteOptions,
  state: ExecutionState,
): void {
  if (state.temporaryWorktree) {
    runGit(options.repoRoot, [
      "worktree",
      "move",
      state.temporaryWorktree,
      options.boardPath,
    ]);
    state.temporaryWorktree = null;
    state.createdWorktree = true;
    return;
  }

  runGit(options.repoRoot, ["worktree", "add", options.boardPath, DATA_BRANCH]);
  state.createdWorktree = true;
}

/**
 * Reads the board's own config out of the branch rather than the filesystem, so
 * verification works before the worktree is attached (design §5.3).
 */
function verifyExistingProject(options: ExecuteOptions): void {
  const ref = readableRef(options);
  const projectPath = `projects/${options.project.projectKey}.yaml`;
  const project = showFile(options.repoRoot, ref, projectPath);

  if (project === null) {
    throw new BootstrapError(
      "E_PROJECT_NOT_FOUND",
      `The existing board has no ${projectPath}.`,
      "Adding a project to an existing board is an M1 API feature, not part of init.",
    );
  }

  const mismatches: string[] = [];
  compareField(mismatches, project, "key", options.project.projectKey);
  compareField(mismatches, project, "name", options.project.projectName);
  compareField(mismatches, project, "timezone", options.project.timezone);

  if (mismatches.length > 0) {
    throw new BootstrapError(
      "E_PROJECT_MISMATCH",
      `The existing project does not match the supplied arguments:\n${mismatches.join("\n")}`,
      "init never edits an existing project. Re-run with the board's current values.",
    );
  }
}

function ensureIdentity(options: ExecuteOptions, state: ExecutionState): void {
  const identity = ensureNodeIdentity(options.boardPath);
  state.nodeId = identity.nodeId;
}

function ensureCodeIgnore(
  options: ExecuteOptions,
  state: ExecutionState,
): void {
  const result = ensureIgnoreRule(
    path.join(options.repoRoot, ".gitignore"),
    CODE_IGNORE_RULE,
  );
  if (!result.changed) {
    return;
  }

  state.codeIgnoreChanged = true;
  state.warnings.push(
    `Added ${CODE_IGNORE_RULE} to the code .gitignore. It is not committed — commit it on your code branch.`,
  );
}

function pushDataBranch(options: ExecuteOptions, state: ExecutionState): void {
  runGit(options.repoRoot, [
    "push",
    "--set-upstream",
    options.remote,
    `${DATA_BRANCH_REF}:${DATA_BRANCH_REF}`,
  ]);
  state.warnings.push(`Pushed ${DATA_BRANCH} to ${options.remote}.`);
}

function rollback(
  plan: BootstrapPlan,
  options: ExecuteOptions,
  state: ExecutionState,
  cause: unknown,
): void {
  // Only artifacts this run created are undone. Existing refs and user data are
  // never removed, even when that leaves a partially initialised repository.
  for (const action of [...plan.rollbackActions].reverse()) {
    try {
      switch (action) {
        case "remove_created_temporary_worktree":
          if (state.temporaryWorktree) {
            removeWorktree(options.repoRoot, state.temporaryWorktree);
            state.temporaryWorktree = null;
          }
          break;
        case "detach_created_board_worktree":
          if (state.createdWorktree) {
            removeWorktree(options.repoRoot, options.boardPath);
            state.createdWorktree = false;
          }
          break;
        case "delete_created_data_branch":
        case "delete_created_local_tracking_branch":
          if (state.createdBranch) {
            runGit(options.repoRoot, ["branch", "--delete", "--force", DATA_BRANCH], {
              allowFailure: true,
            });
            state.createdBranch = false;
          }
          break;
      }
    } catch {
      throw new BootstrapError(
        "E_PARTIAL_BOOTSTRAP",
        `Bootstrap failed and could not be fully rolled back: ${describe(cause)}`,
        "Run localjira doctor and resolve the reported state manually.",
      );
    }
  }
}

function cleanupTemporaryWorktree(
  options: ExecuteOptions,
  state: ExecutionState,
): void {
  if (!state.temporaryWorktree) {
    return;
  }
  removeWorktree(options.repoRoot, state.temporaryWorktree);
  state.temporaryWorktree = null;
}

function removeWorktree(repoRoot: string, target: string): void {
  runGit(repoRoot, ["worktree", "remove", "--force", target], {
    allowFailure: true,
  });
  fs.rmSync(target, { recursive: true, force: true });
  runGit(repoRoot, ["worktree", "prune"], { allowFailure: true });
}

function isBoardAttached(options: ExecuteOptions): boolean {
  return fs.existsSync(path.join(options.boardPath, ".git"));
}

function readableRef(options: ExecuteOptions): string {
  const local = runGit(
    options.repoRoot,
    ["show-ref", "--verify", "--quiet", DATA_BRANCH_REF],
    { allowFailure: true },
  );
  return local.ok ? DATA_BRANCH_REF : remoteBranchRef(options.remote);
}

function showFile(
  repoRoot: string,
  ref: string,
  filePath: string,
): string | null {
  const result = runGit(repoRoot, ["show", `${ref}:${filePath}`], {
    allowFailure: true,
  });
  return result.ok ? result.stdout : null;
}

function compareField(
  mismatches: string[],
  document: string,
  key: string,
  expected: string,
): void {
  const actual = readYamlScalar(document, key);
  if (actual !== expected) {
    mismatches.push(`  ${key}: board has ${format(actual)}, argument is ${format(expected)}`);
  }
}

function readYamlScalar(document: string, key: string): string | null {
  const match = document.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!match) {
    return null;
  }
  const raw = match[1].trim();
  if (!raw.startsWith('"')) {
    return raw;
  }
  return raw
    .slice(1, raw.endsWith('"') ? -1 : undefined)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

function asPushFailure(error: unknown): BootstrapError {
  return new BootstrapError(
    "E_PUSH_FAILED",
    `The local board is initialised, but pushing ${DATA_BRANCH} failed: ${describe(error)}`,
    `Resolve the remote problem and run: git push --set-upstream <remote> ${DATA_BRANCH}`,
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function format(value: string | null): string {
  return value === null ? "nothing" : JSON.stringify(value);
}
