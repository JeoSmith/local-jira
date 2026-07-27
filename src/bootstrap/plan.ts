import type {
  BootstrapSnapshot,
  BootstrapState,
  ClassifiedBootstrapState,
} from "./state.ts";
import { classifyBootstrapState } from "./state.ts";

export type BootstrapAction =
  | "acquire_bootstrap_lock"
  | "fetch_data_branch"
  | "reinspect_repository"
  | "create_orphan_in_temporary_worktree"
  | "write_initial_scaffold"
  | "create_structural_commit"
  | "create_local_tracking_branch"
  | "fast_forward_local_branch"
  | "attach_board_worktree"
  | "verify_existing_project"
  | "ensure_code_ignore"
  | "ensure_data_ignore"
  | "ensure_node_identity"
  | "push_data_branch";

export type BootstrapRollbackAction =
  | "remove_created_temporary_worktree"
  | "detach_created_board_worktree"
  | "delete_created_data_branch"
  | "delete_created_local_tracking_branch";

export interface BootstrapPlanOptions {
  push: boolean;
}

export interface BootstrapPlan {
  state: BootstrapState | null;
  phase: "preparation" | "mutation" | "blocked";
  executable: boolean;
  requiresReinspection: boolean;
  actions: BootstrapAction[];
  rollbackActions: BootstrapRollbackAction[];
  warnings: string[];
  blockedReason: string | null;
}

export function createBootstrapPlan(
  snapshot: BootstrapSnapshot,
  options: BootstrapPlanOptions,
): BootstrapPlan {
  if (options.push && !snapshot.remoteConfigured) {
    return {
      state: null,
      phase: "blocked",
      executable: false,
      requiresReinspection: false,
      actions: [],
      rollbackActions: [],
      warnings: [],
      blockedReason: "--push requires a configured Git remote.",
    };
  }

  const preparation = createPreparationPlan(snapshot);
  if (preparation) {
    return preparation;
  }

  const classified = classifyBootstrapState(snapshot);
  if (!classified.canPlan) {
    return blockedPlan(classified);
  }

  const actions: BootstrapAction[] = [];
  const rollbackActions: BootstrapRollbackAction[] = [];
  const warnings: string[] = [];

  switch (classified.state) {
    case "S0":
      actions.push(
        "create_orphan_in_temporary_worktree",
        "write_initial_scaffold",
        "ensure_data_ignore",
        "create_structural_commit",
        "attach_board_worktree",
        "ensure_node_identity",
        "ensure_code_ignore",
      );
      rollbackActions.push(
        "remove_created_temporary_worktree",
        "detach_created_board_worktree",
        "delete_created_data_branch",
      );
      break;
    case "S1":
      actions.push(
        "verify_existing_project",
        "create_local_tracking_branch",
        "attach_board_worktree",
        "ensure_data_ignore",
        "ensure_node_identity",
        "ensure_code_ignore",
      );
      rollbackActions.push(
        "detach_created_board_worktree",
        "delete_created_local_tracking_branch",
      );
      break;
    case "S2":
      actions.push(
        "verify_existing_project",
        "attach_board_worktree",
        "ensure_data_ignore",
        "ensure_node_identity",
        "ensure_code_ignore",
      );
      rollbackActions.push("detach_created_board_worktree");
      break;
    case "S3":
      actions.push(
        "verify_existing_project",
        "ensure_data_ignore",
        "ensure_node_identity",
        "ensure_code_ignore",
      );
      break;
    case "S8":
      appendS8Actions(
        snapshot,
        options,
        actions,
        rollbackActions,
        warnings,
      );
      break;
    default:
      return blockedPlan({
        ...classified,
        canPlan: false,
        reason: `State ${classified.state} has no mutation plan.`,
      });
  }

  if (options.push) {
    actions.push("push_data_branch");
  }

  return {
    state: classified.state,
    phase: "mutation",
    executable: true,
    requiresReinspection: false,
    actions: deduplicate(actions),
    rollbackActions: deduplicate(rollbackActions),
    warnings,
    blockedReason: null,
  };
}

function appendS8Actions(
  snapshot: BootstrapSnapshot,
  options: BootstrapPlanOptions,
  actions: BootstrapAction[],
  rollbackActions: BootstrapRollbackAction[],
  warnings: string[],
): void {
  actions.push("verify_existing_project");

  if (snapshot.branchRelation === "local_behind") {
    actions.push("fast_forward_local_branch");
  } else if (snapshot.branchRelation === "local_ahead" && !options.push) {
    warnings.push(
      "The local data branch is ahead of its remote. It will not be pushed unless --push is explicit.",
    );
  }

  if (snapshot.boardPathState === "absent") {
    actions.push("attach_board_worktree");
    rollbackActions.push("detach_created_board_worktree");
  }
  actions.push(
    "ensure_data_ignore",
    "ensure_node_identity",
    "ensure_code_ignore",
  );
}

function blockedPlan(classified: ClassifiedBootstrapState): BootstrapPlan {
  return {
    state: classified.state,
    phase: "blocked",
    executable: false,
    requiresReinspection: false,
    actions: [],
    rollbackActions: [],
    warnings: [],
    blockedReason: classified.reason,
  };
}

function createPreparationPlan(
  snapshot: BootstrapSnapshot,
): BootstrapPlan | null {
  if (snapshot.observedUnderLock && snapshot.remoteObservationFresh) {
    return null;
  }

  const actions: BootstrapAction[] = [];
  const lockWasMissing = !snapshot.observedUnderLock;
  if (lockWasMissing) {
    actions.push("acquire_bootstrap_lock");
  }
  if (
    snapshot.remoteConfigured &&
    (lockWasMissing || !snapshot.remoteObservationFresh)
  ) {
    actions.push("fetch_data_branch");
  }
  actions.push("reinspect_repository");

  return {
    state: null,
    phase: "preparation",
    executable: true,
    requiresReinspection: true,
    actions,
    rollbackActions: [],
    warnings: [],
    blockedReason: null,
  };
}

function deduplicate<T>(values: T[]): T[] {
  return [...new Set(values)];
}
