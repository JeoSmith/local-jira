import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inspectBootstrap } from "../../src/bootstrap/doctor.ts";

/**
 * Design §9.4 — kill the process at each mutation step and re-inspect.
 *
 * The child is aborted rather than made to throw, because a thrown error runs
 * the rollback path and that is exactly what a real crash does not do. What is
 * asserted is not "init succeeded" but that the repository is never left in a
 * state that destroys user data or hides the damage.
 */

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

const CRASH_POINTS = [
  "create_orphan_in_temporary_worktree",
  "write_initial_scaffold",
  "ensure_data_ignore",
  "create_structural_commit",
  "attach_board_worktree",
  "ensure_node_identity",
  "ensure_code_ignore",
] as const;

interface Sandbox {
  repo: string;
  board: string;
  headBefore: string;
  statusBefore: string;
  readmeBefore: string;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function gitStatus(cwd: string, args: string[]): number | null {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).status;
}

function makeRepo(t: { after: (fn: () => void) => void }): Sandbox {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "localjira-fault-")),
  );
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Local Jira Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    repo,
    board: path.join(repo, ".localjira"),
    headBefore: git(repo, ["rev-parse", "HEAD"]),
    statusBefore: git(repo, ["status", "--porcelain"]),
    readmeBefore: fs.readFileSync(path.join(repo, "README.md"), "utf8"),
  };
}

function runInitCli(
  repo: string,
  env: NodeJS.ProcessEnv = {},
): { status: number | null; signal: NodeJS.Signals | null; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [
      CLI,
      "init",
      "--project-key",
      "LJ",
      "--project-name",
      "Local Jira",
      "--timezone",
      "Asia/Seoul",
    ],
    { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } },
  );
  return {
    status: result.status,
    signal: result.signal,
    stderr: result.stderr ?? "",
  };
}

/** Invariants that must hold no matter where the crash landed. */
function assertUserDataIntact(sandbox: Sandbox): void {
  const { repo } = sandbox;

  assert.equal(
    git(repo, ["rev-parse", "HEAD"]),
    sandbox.headBefore,
    "the code branch HEAD moved",
  );
  assert.equal(
    git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    "main",
    "the code branch was switched",
  );
  assert.equal(
    fs.readFileSync(path.join(repo, "README.md"), "utf8"),
    sandbox.readmeBefore,
    "a tracked user file changed",
  );
  assert.equal(
    fs.existsSync(path.join(repo, ".gitignore")),
    true,
    "the user's .gitignore was removed",
  );
  assert.match(
    fs.readFileSync(path.join(repo, ".gitignore"), "utf8"),
    /^node_modules$/m,
    "the user's existing ignore rules were lost",
  );

  // At most one structural commit may ever exist on the data branch.
  if (gitStatus(repo, ["show-ref", "--verify", "--quiet", "refs/heads/localjira/data"]) === 0) {
    const count = Number(git(repo, ["rev-list", "--count", "localjira/data"]));
    assert.ok(count <= 1, `expected at most 1 structural commit, found ${count}`);
  }
}

for (const crashAfter of CRASH_POINTS) {
  test(`survives a crash after ${crashAfter}`, (t) => {
    const sandbox = makeRepo(t);

    const crashed = runInitCli(sandbox.repo, {
      LOCALJIRA_CRASH_AFTER: crashAfter,
    });

    // process.abort() surfaces as SIGABRT (or a non-zero status on some hosts).
    assert.ok(
      crashed.signal === "SIGABRT" || crashed.status !== 0,
      `expected an aborted init, got status=${crashed.status} signal=${crashed.signal}`,
    );

    assertUserDataIntact(sandbox);

    // doctor must reach an *accurate* verdict. A crash after the final action
    // leaves a genuinely complete board, so READY is legitimate there — but
    // only if the board really works. Anything else must name the problem.
    const report = inspectBootstrap(sandbox.repo);

    if (report.status === "READY") {
      assert.equal(
        git(sandbox.board, ["rev-parse", "--abbrev-ref", "HEAD"]),
        "localjira/data",
        "READY was reported but the board worktree is not on the data branch",
      );
      for (const file of ["config.yaml", "users.yaml", path.join("projects", "LJ.yaml")]) {
        assert.equal(
          fs.existsSync(path.join(sandbox.board, file)),
          true,
          `READY was reported but ${file} is missing`,
        );
      }
      assert.equal(fs.existsSync(path.join(sandbox.board, ".local", "node.yaml")), true);
    } else {
      assert.ok(report.status.startsWith("E_") || report.status === "UNINITIALIZED");
      assert.ok(
        report.issues.length > 0 || report.status === "UNINITIALIZED",
        "a non-ready verdict must carry an issue explaining it",
      );
    }

    // Any temporary worktree still registered has to be visible in the report.
    const worktrees = git(sandbox.repo, ["worktree", "list", "--porcelain"]);
    if (/\.localjira\.init-/.test(worktrees)) {
      assert.equal(
        report.status,
        "E_PARTIAL_BOOTSTRAP",
        "a leftover init worktree must be reported, not hidden",
      );
      assert.match(report.issues[0]?.message ?? "", /\.localjira\.init-/);
      assert.ok(report.issues[0]?.recovery, "a recovery instruction is required");
    }
  });
}

test("a crashed init never leaves a partially written scaffold file", (t) => {
  const sandbox = makeRepo(t);

  runInitCli(sandbox.repo, { LOCALJIRA_CRASH_AFTER: "write_initial_scaffold" });

  // The scaffold lands in the temporary worktree; whatever exists there must be
  // complete YAML, because each file is written atomically.
  const leftovers = fs
    .readdirSync(sandbox.repo)
    .filter((entry) => entry.startsWith(".localjira.init-"));

  for (const leftover of leftovers) {
    const configPath = path.join(sandbox.repo, leftover, "config.yaml");
    if (!fs.existsSync(configPath)) {
      continue;
    }
    const config = fs.readFileSync(configPath, "utf8");
    assert.match(config, /^schema_version: 1$/m);
    assert.match(config, /^board_id: [0-9A-HJKMNP-TV-Z]{26}$/m);
    assert.ok(config.endsWith("\n"), "an atomically written file ends with a newline");
    assert.equal(
      fs.readdirSync(path.dirname(configPath)).some((f) => f.endsWith(".tmp")),
      false,
      "a temp file was left behind by an interrupted atomic write",
    );
  }
});

test("re-running init after a crash fails explicitly instead of corrupting state", (t) => {
  const sandbox = makeRepo(t);

  runInitCli(sandbox.repo, {
    LOCALJIRA_CRASH_AFTER: "create_orphan_in_temporary_worktree",
  });

  const second = runInitCli(sandbox.repo);

  // The data branch is checked out in the abandoned temporary worktree, so the
  // rerun must refuse and name the path rather than move or delete it.
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /E_BRANCH_CHECKED_OUT|E_PARTIAL_BOOTSTRAP/);
  assert.match(second.stderr, /\.localjira\.init-/);
  assertUserDataIntact(sandbox);
});

test("a crash before any mutation leaves the repository untouched", (t) => {
  const sandbox = makeRepo(t);

  runInitCli(sandbox.repo, {
    LOCALJIRA_CRASH_BEFORE: "create_orphan_in_temporary_worktree",
  });

  assertUserDataIntact(sandbox);
  assert.equal(
    gitStatus(sandbox.repo, ["show-ref", "--verify", "--quiet", "refs/heads/localjira/data"]),
    1,
    "no branch may exist after a crash before the first mutation",
  );
  assert.equal(git(sandbox.repo, ["status", "--porcelain"]), sandbox.statusBefore);
  assert.equal(inspectBootstrap(sandbox.repo).status, "UNINITIALIZED");
});

test("the crash hooks are inert without the environment variable", (t) => {
  const sandbox = makeRepo(t);

  const result = runInitCli(sandbox.repo);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(inspectBootstrap(sandbox.repo).status, "READY");
});
