import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { runInit, runRepairWorktree } from "../../src/bootstrap/commands.ts";
import { inspectBootstrap } from "../../src/bootstrap/doctor.ts";
import { BootstrapError } from "../../src/bootstrap/execute.ts";

const PROJECT = {
  projectKey: "LJ",
  projectName: "Local Jira",
  timezone: "Asia/Seoul",
};

interface Sandbox {
  repo: string;
  board: string;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** An isolated repository, never the user's own workspace (design §9). */
function makeRepo(t: { after: (fn: () => void) => void }): Sandbox {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "localjira-init-")),
  );
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Local Jira Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { repo, board: path.join(repo, ".localjira") };
}

function makeBareRemote(sandbox: Sandbox, name = "origin"): string {
  const remotePath = path.join(path.dirname(sandbox.repo), `${name}.git`);
  git(path.dirname(sandbox.repo), ["init", "--bare", remotePath]);
  git(sandbox.repo, ["remote", "add", name, remotePath]);
  return remotePath;
}

test("initialises a board on a repository with no data branch (S0)", async (t) => {
  const { repo, board } = makeRepo(t);

  const result = await runInit({ cwd: repo, project: PROJECT });

  assert.equal(result.status, "initialized");
  assert.equal(result.boardPath, board);
  assert.ok(result.boardId);
  assert.ok(result.nodeId);

  // The board is a worktree of the orphan branch.
  assert.equal(
    git(board, ["rev-parse", "--abbrev-ref", "HEAD"]),
    "localjira/data",
  );
  for (const file of [".gitattributes", ".gitignore", "config.yaml", "users.yaml"]) {
    assert.equal(fs.existsSync(path.join(board, file)), true, `${file} missing`);
  }
  assert.equal(fs.existsSync(path.join(board, "projects", "LJ.yaml")), true);
  assert.equal(fs.existsSync(path.join(board, ".local", "node.yaml")), true);

  // Exactly one structural commit, and it is unrelated to the code history.
  assert.equal(git(repo, ["rev-list", "--count", "localjira/data"]), "1");
  assert.equal(
    spawnSync("git", ["merge-base", "main", "localjira/data"], { cwd: repo }).status,
    1,
    "the data branch must not share history with the code branch",
  );

  // The code branch was never switched, and .gitignore is the only path the
  // code worktree sees as changed — the board itself is ignored.
  assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  const status = git(repo, ["status", "--porcelain"]).split("\n").filter(Boolean);
  assert.deepEqual(
    status.map((line) => line.slice(3)),
    [".gitignore"],
    `unexpected working tree changes: ${status.join(", ")}`,
  );
  assert.equal(result.codeIgnoreChanged, true);
  // init never commits on the code branch (D4).
  assert.equal(git(repo, ["rev-list", "--count", "main"]), "1");
});

test("leaves no temporary worktree behind", async (t) => {
  const { repo } = makeRepo(t);
  await runInit({ cwd: repo, project: PROJECT });

  const worktrees = git(repo, ["worktree", "list", "--porcelain"]);
  assert.equal(/\.localjira\.init-/.test(worktrees), false, worktrees);
  assert.equal(
    fs.readdirSync(repo).some((entry) => entry.startsWith(".localjira.init-")),
    false,
  );
});

test("ignores the board from the code branch and .local from the data branch", async (t) => {
  const { repo, board } = makeRepo(t);
  await runInit({ cwd: repo, project: PROJECT });

  assert.equal(
    spawnSync("git", ["check-ignore", "-q", ".localjira"], { cwd: repo }).status,
    0,
  );
  assert.equal(
    spawnSync("git", ["check-ignore", "-q", ".local"], { cwd: board }).status,
    0,
  );
  // The data branch tracks no .local file at all.
  assert.equal(
    git(board, ["ls-files", ".local"]),
    "",
  );
});

test("doctor reports READY after init", async (t) => {
  const { repo } = makeRepo(t);
  await runInit({ cwd: repo, project: PROJECT });

  const report = inspectBootstrap(repo);
  assert.equal(report.status, "READY");
  assert.equal(report.ok, true);
});

test("is idempotent and preserves the board id (S3)", async (t) => {
  const { repo, board } = makeRepo(t);
  const first = await runInit({ cwd: repo, project: PROJECT });
  const configBefore = fs.readFileSync(path.join(board, "config.yaml"), "utf8");
  const headBefore = git(repo, ["rev-parse", "localjira/data"]);

  const second = await runInit({ cwd: repo, project: PROJECT });

  assert.equal(second.status, "already_initialized");
  assert.equal(second.nodeId, first.nodeId);
  assert.equal(fs.readFileSync(path.join(board, "config.yaml"), "utf8"), configBefore);
  assert.equal(git(repo, ["rev-parse", "localjira/data"]), headBefore);
  assert.equal(git(repo, ["rev-list", "--count", "localjira/data"]), "1");
});

test("reattaches a detached board worktree without touching the branch (S2)", async (t) => {
  const { repo, board } = makeRepo(t);
  await runInit({ cwd: repo, project: PROJECT });
  const headBefore = git(repo, ["rev-parse", "localjira/data"]);

  git(repo, ["worktree", "remove", "--force", board]);
  assert.equal(fs.existsSync(board), false);

  const repaired = await runRepairWorktree({ cwd: repo });

  assert.equal(repaired.status, "repaired");
  assert.equal(git(board, ["rev-parse", "--abbrev-ref", "HEAD"]), "localjira/data");
  assert.equal(git(repo, ["rev-parse", "localjira/data"]), headBefore);
});

test("repair-worktree refuses to bootstrap an uninitialised repository", async (t) => {
  const { repo } = makeRepo(t);

  await assert.rejects(
    () => runRepairWorktree({ cwd: repo }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.code, "E_BOARD_NOT_INITIALIZED");
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(repo, ".localjira")), false);
});

test("refuses to run from a linked worktree", async (t) => {
  const { repo } = makeRepo(t);
  const linked = path.join(path.dirname(repo), "linked");
  git(repo, ["worktree", "add", "-b", "feature", linked]);

  await assert.rejects(
    () => runInit({ cwd: linked, project: PROJECT }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.code, "E_NOT_PRIMARY_WORKTREE");
      return true;
    },
  );
});

test("preserves an occupied board path instead of overwriting it (S5)", async (t) => {
  const { repo, board } = makeRepo(t);
  fs.mkdirSync(board);
  fs.writeFileSync(path.join(board, "notes.txt"), "user data\n");

  await assert.rejects(
    () => runInit({ cwd: repo, project: PROJECT }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.code, "E_BOARD_PATH_OCCUPIED");
      return true;
    },
  );

  assert.equal(fs.readFileSync(path.join(board, "notes.txt"), "utf8"), "user data\n");
  assert.equal(
    spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/localjira/data"], {
      cwd: repo,
    }).status,
    1,
    "no branch may be created when the path is blocked",
  );
});

test("rejects --push without a configured remote before touching the repository", async (t) => {
  const { repo } = makeRepo(t);

  await assert.rejects(
    () => runInit({ cwd: repo, project: PROJECT, push: true }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.code, "E_REMOTE_NOT_CONFIGURED");
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(repo, ".localjira")), false);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
});

test("does not touch the network unless --push is given", async (t) => {
  const sandbox = makeRepo(t);
  const remotePath = makeBareRemote(sandbox);

  await runInit({ cwd: sandbox.repo, project: PROJECT });

  assert.equal(
    spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/localjira/data"], {
      cwd: remotePath,
    }).status,
    1,
    "init must not push implicitly",
  );
});

test("pushes and sets upstream when --push is explicit", async (t) => {
  const sandbox = makeRepo(t);
  const remotePath = makeBareRemote(sandbox);

  await runInit({ cwd: sandbox.repo, project: PROJECT, push: true });

  assert.equal(
    spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/localjira/data"], {
      cwd: remotePath,
    }).status,
    0,
  );
  assert.equal(
    git(sandbox.repo, ["rev-parse", "--abbrev-ref", "localjira/data@{upstream}"]),
    "origin/localjira/data",
  );
});

test("adopts an existing shared board from a remote (S1)", async (t) => {
  const publisher = makeRepo(t);
  const remotePath = makeBareRemote(publisher);
  await runInit({ cwd: publisher.repo, project: PROJECT, push: true });

  // A second clone that has never seen the board.
  const consumer = makeRepo(t);
  git(consumer.repo, ["remote", "add", "origin", remotePath]);

  const result = await runInit({ cwd: consumer.repo, project: PROJECT });

  assert.equal(result.status, "initialized");
  assert.equal(
    git(consumer.board, ["rev-parse", "--abbrev-ref", "HEAD"]),
    "localjira/data",
  );
  // Same board, so the same board id — it was adopted, not recreated.
  assert.match(
    fs.readFileSync(path.join(consumer.board, "config.yaml"), "utf8"),
    new RegExp(`board_id: ${(await readBoardId(publisher.board))}`),
  );
  // The node identity is per installation, so it must differ.
  assert.notEqual(result.nodeId, null);
});

test("refuses to adopt a board whose project differs", async (t) => {
  const publisher = makeRepo(t);
  const remotePath = makeBareRemote(publisher);
  await runInit({ cwd: publisher.repo, project: PROJECT, push: true });

  const consumer = makeRepo(t);
  git(consumer.repo, ["remote", "add", "origin", remotePath]);

  await assert.rejects(
    () =>
      runInit({
        cwd: consumer.repo,
        project: { ...PROJECT, projectName: "Different Name" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.code, "E_PROJECT_MISMATCH");
      return true;
    },
  );
  assert.equal(fs.existsSync(consumer.board), false);
});

test("refuses to adopt a board that lacks the requested project", async (t) => {
  const publisher = makeRepo(t);
  const remotePath = makeBareRemote(publisher);
  await runInit({ cwd: publisher.repo, project: PROJECT, push: true });

  const consumer = makeRepo(t);
  git(consumer.repo, ["remote", "add", "origin", remotePath]);

  await assert.rejects(
    () =>
      runInit({
        cwd: consumer.repo,
        project: { ...PROJECT, projectKey: "OTHER" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.code, "E_PROJECT_NOT_FOUND");
      return true;
    },
  );
});

test("refuses to merge diverged board branches (S8)", async (t) => {
  const publisher = makeRepo(t);
  const remotePath = makeBareRemote(publisher);
  await runInit({ cwd: publisher.repo, project: PROJECT, push: true });

  const consumer = makeRepo(t);
  git(consumer.repo, ["remote", "add", "origin", remotePath]);
  await runInit({ cwd: consumer.repo, project: PROJECT });

  // Both sides commit something different on top of the shared root.
  fs.writeFileSync(path.join(publisher.board, "config.yaml"), "schema_version: 1\nboard_id: A\n");
  git(publisher.board, ["commit", "-am", "publisher change"]);
  git(publisher.repo, ["push", "origin", "localjira/data"]);

  fs.writeFileSync(path.join(consumer.board, "users.yaml"), "schema_version: 1\nusers: []\n# local\n");
  git(consumer.board, ["commit", "-am", "consumer change"]);

  await assert.rejects(
    () => runInit({ cwd: consumer.repo, project: PROJECT }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.code, "E_DATA_BRANCH_DIVERGED");
      return true;
    },
  );
});

test("refuses when the data branch is checked out elsewhere (S4)", async (t) => {
  const { repo, board } = makeRepo(t);
  await runInit({ cwd: repo, project: PROJECT });

  const elsewhere = path.join(path.dirname(repo), "elsewhere");
  git(repo, ["worktree", "remove", "--force", board]);
  git(repo, ["worktree", "add", elsewhere, "localjira/data"]);

  await assert.rejects(
    () => runInit({ cwd: repo, project: PROJECT }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.code, "E_BRANCH_CHECKED_OUT");
      assert.match(error.recovery ?? "", /elsewhere/);
      return true;
    },
  );
});

test("appends the code ignore rule without disturbing existing content", async (t) => {
  const { repo } = makeRepo(t);
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\r\ndist\r\n");

  await runInit({ cwd: repo, project: PROJECT });

  const contents = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
  assert.equal(contents, "node_modules\r\ndist\r\n/.localjira/\r\n");
});

test("does not duplicate an ignore rule that is already in force", async (t) => {
  const { repo } = makeRepo(t);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".localjira\n");

  const result = await runInit({ cwd: repo, project: PROJECT });

  assert.equal(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), ".localjira\n");
  assert.equal(result.codeIgnoreChanged, false);
});

async function readBoardId(board: string): Promise<string> {
  const config = fs.readFileSync(path.join(board, "config.yaml"), "utf8");
  return config.match(/^board_id: (.+)$/m)?.[1] ?? "";
}
