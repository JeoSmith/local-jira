import {
  BootstrapError,
  executePlan,
  type BootstrapErrorCode,
} from "./execute.ts";
import { resolveGitCommonDir, runGit } from "./git.ts";
import type { ProjectInput } from "./input.ts";
import { acquireBootstrapLock } from "./lock.ts";
import { DATA_BRANCH } from "./model.ts";
import {
  buildSnapshot,
  DEFAULT_REMOTE,
  isRemoteConfigured,
  remoteBranchRef,
  resolveRepositoryContext,
  type RepositoryContext,
} from "./inspect.ts";
import { createBootstrapPlan, type BootstrapAction, type BootstrapPlan } from "./plan.ts";
import type { BootstrapSnapshot } from "./state.ts";

export interface CommandOptions {
  cwd: string;
  remote?: string;
  push?: boolean;
  project?: ProjectInput;
  now?: string;
}

export interface CommandResult {
  status: "initialized" | "already_initialized" | "repaired";
  repoRoot: string;
  boardPath: string;
  branch: string;
  projectKey: string | null;
  actions: BootstrapAction[];
  warnings: string[];
  boardId: string | null;
  nodeId: string | null;
  codeIgnoreChanged: boolean;
}

export async function runInit(options: CommandOptions): Promise<CommandResult> {
  const project = options.project;
  if (!project) {
    throw new BootstrapError(
      "E_PARTIAL_BOOTSTRAP",
      "init requires --project-key, --project-name and --timezone.",
    );
  }

  const context = requirePrimaryWorktree(options.cwd);
  const remote = options.remote ?? DEFAULT_REMOTE;

  if (options.push && !isRemoteConfigured(context.repoRoot, remote)) {
    // Checked before the lock so an impossible request never touches the repo.
    throw new BootstrapError(
      "E_REMOTE_NOT_CONFIGURED",
      `--push was requested but the remote "${remote}" is not configured.`,
      `Add the remote first: git remote add ${remote} <url>`,
    );
  }

  return withBootstrapLock(context, async () => {
    const snapshot = observe(context, remote);
    const plan = planMutation(context, snapshot, remote, options.push ?? false);

    const alreadyReady = plan.state === "S3" && !options.push;
    const result = executePlan(plan, {
      repoRoot: context.repoRoot,
      boardPath: context.boardPath,
      remote,
      push: options.push ?? false,
      project,
      now: options.now,
    });

    return {
      status: alreadyReady ? "already_initialized" : "initialized",
      repoRoot: context.repoRoot,
      boardPath: context.boardPath,
      branch: DATA_BRANCH,
      projectKey: project.projectKey,
      actions: result.actions,
      warnings: result.warnings,
      boardId: result.boardId,
      nodeId: result.nodeId,
      codeIgnoreChanged: result.codeIgnoreChanged,
    } satisfies CommandResult;
  });
}

/**
 * Reattaches a board whose worktree disappeared. It never creates a branch or a
 * project, so it cannot be used to bootstrap a repository by accident.
 */
export async function runRepairWorktree(
  options: CommandOptions,
): Promise<CommandResult> {
  const context = requirePrimaryWorktree(options.cwd);
  const remote = options.remote ?? DEFAULT_REMOTE;

  return withBootstrapLock(context, async () => {
    const snapshot = observe(context, remote);

    if (!snapshot.localBranchExists && !snapshot.remoteBranchExists) {
      throw new BootstrapError(
        "E_BOARD_NOT_INITIALIZED",
        `No ${DATA_BRANCH} branch exists locally or on "${remote}".`,
        "Run localjira init to create a board.",
      );
    }
    if (snapshot.boardPathState === "correct_worktree") {
      return {
        status: "repaired",
        repoRoot: context.repoRoot,
        boardPath: context.boardPath,
        branch: DATA_BRANCH,
        projectKey: null,
        actions: [],
        warnings: ["The board worktree is already attached."],
        boardId: null,
        nodeId: null,
        codeIgnoreChanged: false,
      } satisfies CommandResult;
    }

    const plan = planMutation(context, snapshot, remote, false);
    const repairActions = new Set<BootstrapAction>([
      "create_local_tracking_branch",
      "fast_forward_local_branch",
      "attach_board_worktree",
      "ensure_data_ignore",
      "ensure_node_identity",
      "ensure_code_ignore",
    ]);

    const result = executePlan(
      {
        ...plan,
        actions: plan.actions.filter((action) => repairActions.has(action)),
      },
      {
        repoRoot: context.repoRoot,
        boardPath: context.boardPath,
        remote,
        push: false,
        project: options.project ?? {
          projectKey: "",
          projectName: "",
          timezone: "UTC",
        },
        now: options.now,
      },
    );

    return {
      status: "repaired",
      repoRoot: context.repoRoot,
      boardPath: context.boardPath,
      branch: DATA_BRANCH,
      projectKey: null,
      actions: result.actions,
      warnings: result.warnings,
      boardId: result.boardId,
      nodeId: result.nodeId,
      codeIgnoreChanged: result.codeIgnoreChanged,
    } satisfies CommandResult;
  });
}

function requirePrimaryWorktree(cwd: string): RepositoryContext {
  const context = resolveRepositoryContext(cwd);
  if (!context) {
    throw new BootstrapError(
      "E_NOT_GIT_REPOSITORY",
      "The current directory is not inside a Git worktree.",
      "Run the command from the repository primary worktree.",
    );
  }
  if (!context.isPrimaryWorktree) {
    throw new BootstrapError(
      "E_NOT_PRIMARY_WORKTREE",
      `Initialization is restricted to the primary worktree: ${context.repoRoot}`,
      `cd ${context.repoRoot} && localjira doctor`,
    );
  }
  return context;
}

async function withBootstrapLock<T>(
  context: RepositoryContext,
  body: () => Promise<T>,
): Promise<T> {
  const commonDir = resolveGitCommonDir(context.repoRoot);
  if (!commonDir) {
    throw new BootstrapError(
      "E_NOT_GIT_REPOSITORY",
      "The Git common directory could not be resolved.",
    );
  }

  const lock = await acquireBootstrapLock(commonDir);
  try {
    return await body();
  } finally {
    await lock.release();
  }
}

/**
 * Observes the repository, runs the preparation phase the plan asks for
 * (an exact-refspec fetch), then observes again so the mutation plan is built
 * from post-fetch state.
 */
function observe(
  context: RepositoryContext,
  remote: string,
): BootstrapSnapshot {
  const initial = buildSnapshot(context, {
    remote,
    observedUnderLock: true,
    remoteObservationFresh: false,
  });

  const preparation = createBootstrapPlan(initial, { push: false });
  if (preparation.phase !== "preparation") {
    return initial;
  }

  if (preparation.actions.includes("fetch_data_branch")) {
    fetchDataBranch(context.repoRoot, remote);
  }

  return buildSnapshot(context, {
    remote,
    observedUnderLock: true,
    remoteObservationFresh: true,
  });
}

function fetchDataBranch(repoRoot: string, remote: string): void {
  // Exact refspec only: a blanket fetch would move refs the user did not ask
  // this command to touch (design §5.3). A missing remote branch is a normal
  // outcome, not an error.
  runGit(
    repoRoot,
    [
      "fetch",
      remote,
      `+refs/heads/${DATA_BRANCH}:${remoteBranchRef(remote)}`,
    ],
    { allowFailure: true },
  );
}

function planMutation(
  context: RepositoryContext,
  snapshot: BootstrapSnapshot,
  remote: string,
  push: boolean,
): BootstrapPlan {
  const plan = createBootstrapPlan(snapshot, { push });
  if (plan.executable && plan.phase === "mutation") {
    return plan;
  }

  throw new BootstrapError(
    blockedErrorCode(snapshot, plan),
    plan.blockedReason ?? "The repository is not in a state Local Jira can initialise.",
    blockedRecovery(snapshot, context),
  );
}

function blockedErrorCode(
  snapshot: BootstrapSnapshot,
  plan: BootstrapPlan,
): BootstrapErrorCode {
  if (snapshot.boardPathState === "symlink") {
    return "E_UNSAFE_BOARD_PATH";
  }
  switch (plan.state) {
    case "S4":
      return "E_BRANCH_CHECKED_OUT";
    case "S6":
      return "E_WRONG_WORKTREE_BRANCH";
    case "S5":
    case "S7":
      return "E_BOARD_PATH_OCCUPIED";
    case "S8":
      return "E_DATA_BRANCH_DIVERGED";
    default:
      return "E_PARTIAL_BOOTSTRAP";
  }
}

function blockedRecovery(
  snapshot: BootstrapSnapshot,
  context: RepositoryContext,
): string {
  if (snapshot.dataBranchCheckoutPath) {
    return `The data branch is checked out at ${snapshot.dataBranchCheckoutPath}. Local Jira will not move or remove it.`;
  }
  if (
    snapshot.boardPathState === "occupied" ||
    snapshot.boardPathState === "symlink"
  ) {
    return `Inspect ${context.boardPath} and move it yourself; Local Jira preserves existing paths.`;
  }
  if (snapshot.branchRelation === "diverged") {
    return `Reconcile ${DATA_BRANCH} with its remote manually; init never merges or rebases board data.`;
  }
  return "Run localjira doctor for the current state.";
}
