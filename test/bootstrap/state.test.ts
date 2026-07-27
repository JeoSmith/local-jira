import assert from "node:assert/strict";
import test from "node:test";

import { createBootstrapPlan } from "../../src/bootstrap/plan.ts";
import {
  classifyBootstrapState,
  type BootstrapSnapshot,
} from "../../src/bootstrap/state.ts";

const base: BootstrapSnapshot = {
  observedUnderLock: true,
  remoteConfigured: false,
  remoteObservationFresh: true,
  localBranchExists: false,
  remoteBranchExists: false,
  boardPathState: "absent",
  boardWorktreeBranch: null,
  dataBranchCheckoutPath: null,
  boardPath: "/repo/.localjira",
  branchRelation: "not_applicable",
};

test("classifies the safe S0-S3 bootstrap paths", () => {
  assert.equal(classifyBootstrapState(base).state, "S0");
  assert.equal(
    classifyBootstrapState({
      ...base,
      remoteConfigured: true,
      remoteBranchExists: true,
    }).state,
    "S1",
  );
  assert.equal(
    classifyBootstrapState({
      ...base,
      localBranchExists: true,
    }).state,
    "S2",
  );
  assert.equal(
    classifyBootstrapState({
      ...base,
      localBranchExists: true,
      boardPathState: "correct_worktree",
      boardWorktreeBranch: "refs/heads/localjira/data",
    }).state,
    "S3",
  );
});

test("classifies unsafe paths before considering branch creation", () => {
  const occupied = classifyBootstrapState({
    ...base,
    boardPathState: "occupied",
  });
  assert.deepEqual(
    { state: occupied.state, canPlan: occupied.canPlan },
    { state: "S5", canPlan: false },
  );

  const remoteAndOccupied = classifyBootstrapState({
    ...base,
    remoteConfigured: true,
    remoteBranchExists: true,
    boardPathState: "symlink",
  });
  assert.deepEqual(
    { state: remoteAndOccupied.state, canPlan: remoteAndOccupied.canPlan },
    { state: "S7", canPlan: false },
  );
});

test("blocks a branch checked out at another path and a wrong worktree", () => {
  const checkedOut = classifyBootstrapState({
    ...base,
    localBranchExists: true,
    dataBranchCheckoutPath: "/other/board",
  });
  assert.equal(checkedOut.state, "S4");
  assert.equal(checkedOut.canPlan, false);

  const wrongBranch = classifyBootstrapState({
    ...base,
    localBranchExists: true,
    boardPathState: "wrong_worktree",
    boardWorktreeBranch: "refs/heads/main",
  });
  assert.equal(wrongBranch.state, "S6");
  assert.equal(wrongBranch.canPlan, false);
});

test("allows only non-diverged S8 relations", () => {
  for (const relation of ["equal", "local_behind", "local_ahead"] as const) {
    const result = classifyBootstrapState({
      ...base,
      remoteConfigured: true,
      localBranchExists: true,
      remoteBranchExists: true,
      branchRelation: relation,
    });
    assert.equal(result.state, "S8");
    assert.equal(result.canPlan, true);
  }

  const diverged = classifyBootstrapState({
    ...base,
    remoteConfigured: true,
    localBranchExists: true,
    remoteBranchExists: true,
    branchRelation: "diverged",
  });
  assert.equal(diverged.state, "S8");
  assert.equal(diverged.canPlan, false);

  const unknown = classifyBootstrapState({
    ...base,
    remoteConfigured: true,
    localBranchExists: true,
    remoteBranchExists: true,
    branchRelation: "not_applicable",
  });
  assert.equal(unknown.state, "S8");
  assert.equal(unknown.canPlan, false);
});

test("builds an ordered S0 plan without implicit push", () => {
  const plan = createBootstrapPlan(base, { push: false });

  assert.equal(plan.state, "S0");
  assert.equal(plan.executable, true);
  assert.deepEqual(plan.actions, [
    "create_orphan_in_temporary_worktree",
    "write_initial_scaffold",
    "ensure_data_ignore",
    "create_structural_commit",
    "attach_board_worktree",
    "ensure_node_identity",
    "ensure_code_ignore",
  ]);
  assert.deepEqual(plan.rollbackActions, [
    "remove_created_temporary_worktree",
    "detach_created_board_worktree",
    "delete_created_data_branch",
  ]);
  assert.equal(plan.actions.includes("push_data_branch"), false);
});

test("adds push only when explicit", () => {
  const plan = createBootstrapPlan(
    { ...base, remoteConfigured: true },
    { push: true },
  );
  assert.equal(plan.actions.at(-1), "push_data_branch");
});

test("blocks explicit push when no remote is configured", () => {
  const plan = createBootstrapPlan(base, { push: true });
  assert.equal(plan.phase, "blocked");
  assert.equal(plan.executable, false);
  assert.match(plan.blockedReason ?? "", /configured Git remote/);
});

test("plans a fast-forward but blocks divergence", () => {
  const behind = createBootstrapPlan(
    {
      ...base,
      remoteConfigured: true,
      localBranchExists: true,
      remoteBranchExists: true,
      branchRelation: "local_behind",
    },
    { push: false },
  );
  assert.equal(behind.executable, true);
  assert.equal(behind.actions.includes("fast_forward_local_branch"), true);

  const diverged = createBootstrapPlan(
    {
      ...base,
      remoteConfigured: true,
      localBranchExists: true,
      remoteBranchExists: true,
      branchRelation: "diverged",
    },
    { push: true },
  );
  assert.equal(diverged.executable, false);
  assert.deepEqual(diverged.actions, []);
});

test("warns about an ahead branch only when push is not explicit", () => {
  const snapshot: BootstrapSnapshot = {
    ...base,
    remoteConfigured: true,
    localBranchExists: true,
    remoteBranchExists: true,
    branchRelation: "local_ahead",
  };

  assert.equal(createBootstrapPlan(snapshot, { push: false }).warnings.length, 1);
  assert.deepEqual(createBootstrapPlan(snapshot, { push: true }).warnings, []);
});

test("an existing ready board produces verification-only actions", () => {
  const plan = createBootstrapPlan(
    {
      ...base,
      localBranchExists: true,
      boardPathState: "correct_worktree",
      boardWorktreeBranch: "refs/heads/localjira/data",
    },
    { push: false },
  );

  assert.deepEqual(plan.actions, [
    "verify_existing_project",
    "ensure_data_ignore",
    "ensure_node_identity",
    "ensure_code_ignore",
  ]);
});

test("prepares under lock and freshens remote state before mutation planning", () => {
  const unlocked = createBootstrapPlan(
    {
      ...base,
      observedUnderLock: false,
      remoteConfigured: true,
      remoteObservationFresh: false,
    },
    { push: false },
  );
  assert.equal(unlocked.phase, "preparation");
  assert.equal(unlocked.requiresReinspection, true);
  assert.deepEqual(unlocked.actions, [
    "acquire_bootstrap_lock",
    "fetch_data_branch",
    "reinspect_repository",
  ]);

  const lockedButStale = createBootstrapPlan(
    {
      ...base,
      remoteConfigured: true,
      remoteObservationFresh: false,
    },
    { push: false },
  );
  assert.deepEqual(lockedButStale.actions, [
    "fetch_data_branch",
    "reinspect_repository",
  ]);

  const unlockedButPreviouslyFresh = createBootstrapPlan(
    {
      ...base,
      observedUnderLock: false,
      remoteConfigured: true,
      remoteObservationFresh: true,
    },
    { push: false },
  );
  assert.deepEqual(unlockedButPreviouslyFresh.actions, [
    "acquire_bootstrap_lock",
    "fetch_data_branch",
    "reinspect_repository",
  ]);
});

test("classifies equal local and remote branches as S8", () => {
  for (const boardPathState of ["absent", "correct_worktree"] as const) {
    const result = classifyBootstrapState({
      ...base,
      remoteConfigured: true,
      localBranchExists: true,
      remoteBranchExists: true,
      branchRelation: "equal",
      boardPathState,
      boardWorktreeBranch:
        boardPathState === "correct_worktree"
          ? "refs/heads/localjira/data"
          : null,
    });
    assert.equal(result.state, "S8");
    assert.equal(result.canPlan, true);
  }
});

test("verifies existing content before attaching a worktree", () => {
  for (const snapshot of [
    {
      ...base,
      remoteConfigured: true,
      remoteBranchExists: true,
      branchRelation: "not_applicable" as const,
    },
    {
      ...base,
      localBranchExists: true,
    },
  ]) {
    const plan = createBootstrapPlan(snapshot, { push: false });
    const verify = plan.actions.indexOf("verify_existing_project");
    const attach = plan.actions.indexOf("attach_board_worktree");
    assert.ok(verify >= 0);
    assert.ok(attach > verify);
    assert.ok(plan.rollbackActions.includes("detach_created_board_worktree"));
  }
});

test("verifies the remote target before fast-forwarding local data", () => {
  const plan = createBootstrapPlan(
    {
      ...base,
      remoteConfigured: true,
      localBranchExists: true,
      remoteBranchExists: true,
      branchRelation: "local_behind",
    },
    { push: false },
  );

  assert.ok(
    plan.actions.indexOf("verify_existing_project") <
      plan.actions.indexOf("fast_forward_local_branch"),
  );
});

test("blocks internally contradictory remote snapshots", () => {
  const result = classifyBootstrapState({
    ...base,
    remoteBranchExists: true,
  });
  assert.equal(result.canPlan, false);
  assert.equal(result.state, "S8");
});

test("unsafe S4-S7 states never receive mutation or rollback actions", () => {
  const snapshots: BootstrapSnapshot[] = [
    {
      ...base,
      localBranchExists: true,
      dataBranchCheckoutPath: "/other",
    },
    { ...base, boardPathState: "occupied" },
    {
      ...base,
      localBranchExists: true,
      boardPathState: "wrong_worktree",
      boardWorktreeBranch: "refs/heads/main",
    },
    {
      ...base,
      remoteConfigured: true,
      remoteBranchExists: true,
      boardPathState: "occupied",
    },
  ];

  for (const snapshot of snapshots) {
    const plan = createBootstrapPlan(snapshot, { push: false });
    assert.equal(plan.executable, false);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.rollbackActions, []);
  }
});
