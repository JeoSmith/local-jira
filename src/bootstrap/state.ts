import { DATA_BRANCH_REF } from "./model.ts";

export type BootstrapState = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8";

export type BoardPathState =
  | "absent"
  | "correct_worktree"
  | "wrong_worktree"
  | "occupied"
  | "symlink";

export type BranchRelation =
  | "not_applicable"
  | "equal"
  | "local_behind"
  | "local_ahead"
  | "diverged";

export interface BootstrapSnapshot {
  observedUnderLock: boolean;
  remoteConfigured: boolean;
  remoteObservationFresh: boolean;
  localBranchExists: boolean;
  remoteBranchExists: boolean;
  boardPathState: BoardPathState;
  boardWorktreeBranch: string | null;
  dataBranchCheckoutPath: string | null;
  boardPath: string;
  branchRelation: BranchRelation;
}

export interface ClassifiedBootstrapState {
  state: BootstrapState;
  canPlan: boolean;
  reason: string;
}

export function classifyBootstrapState(
  snapshot: BootstrapSnapshot,
): ClassifiedBootstrapState {
  if (
    !snapshot.remoteConfigured &&
    (snapshot.remoteBranchExists ||
      snapshot.branchRelation !== "not_applicable")
  ) {
    return blocked(
      "S8",
      "The snapshot contains remote branch state without a configured remote.",
    );
  }

  if (
    snapshot.boardPathState === "occupied" ||
    snapshot.boardPathState === "symlink"
  ) {
    if (!snapshot.localBranchExists && snapshot.remoteBranchExists) {
      return blocked(
        "S7",
        "A remote data branch exists, but the board path is occupied.",
      );
    }
    return blocked("S5", "The board path is not a registered Git worktree.");
  }

  if (snapshot.boardPathState === "wrong_worktree") {
    return blocked(
      "S6",
      `The board path is attached to ${snapshot.boardWorktreeBranch ?? "detached HEAD"}, not ${DATA_BRANCH_REF}.`,
    );
  }

  if (
    snapshot.dataBranchCheckoutPath &&
    snapshot.boardPathState !== "correct_worktree"
  ) {
    return blocked(
      "S4",
      `The data branch is already checked out at ${snapshot.dataBranchCheckoutPath}.`,
    );
  }

  if (snapshot.localBranchExists && snapshot.remoteBranchExists) {
    if (
      snapshot.branchRelation === "not_applicable" ||
      snapshot.branchRelation === "diverged"
    ) {
      return blocked(
        "S8",
        snapshot.branchRelation === "diverged"
          ? "Local and remote data branches have diverged."
          : "Local and remote data branches exist, but their ancestry relation is unknown.",
      );
    }
    return {
      state: "S8",
      canPlan: true,
      reason: `Local and remote data branches are ${snapshot.branchRelation}.`,
    };
  }

  if (
    !snapshot.localBranchExists &&
    !snapshot.remoteBranchExists &&
    snapshot.boardPathState === "absent"
  ) {
    return ready("S0", "No data branch or board worktree exists.");
  }

  if (
    !snapshot.localBranchExists &&
    snapshot.remoteBranchExists &&
    snapshot.boardPathState === "absent"
  ) {
    return ready("S1", "A remote data branch is available to attach.");
  }

  if (
    snapshot.localBranchExists &&
    snapshot.boardPathState === "absent"
  ) {
    return ready("S2", "A local data branch is available to attach.");
  }

  if (
    snapshot.localBranchExists &&
    snapshot.boardPathState === "correct_worktree"
  ) {
    return ready("S3", "The data branch is attached at the board path.");
  }

  return blocked(
    "S5",
    "The observed Git state does not match a safe bootstrap transition.",
  );
}

function ready(state: BootstrapState, reason: string): ClassifiedBootstrapState {
  return { state, canPlan: true, reason };
}

function blocked(state: BootstrapState, reason: string): ClassifiedBootstrapState {
  return { state, canPlan: false, reason };
}
