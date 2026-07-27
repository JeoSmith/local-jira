import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  BOARD_DIRECTORY,
  DATA_BRANCH,
  DATA_BRANCH_REF,
  type DiagnosticIssue,
  type DoctorReport,
  type Worktree,
} from "./model.ts";
import {
  canonicalPath,
  listWorktrees,
  refExists,
  resolveCurrentRoot,
} from "./git.ts";

const REQUIRED_FILES = [
  ".gitattributes",
  ".gitignore",
  "config.yaml",
  "users.yaml",
] as const;

export function inspectBootstrap(cwd: string): DoctorReport {
  const empty = emptyReport();
  const currentRoot = resolveCurrentRoot(cwd);

  if (!currentRoot) {
    return {
      ...empty,
      status: "E_NOT_GIT_REPOSITORY",
      issues: [
        {
          code: "E_NOT_GIT_REPOSITORY",
          message: "The current directory is not inside a Git worktree.",
          recovery: "Run localjira doctor from the repository primary worktree.",
        },
      ],
    };
  }

  const worktrees = listWorktrees(currentRoot);
  const primary = worktrees[0];
  const repoRoot = primary?.path ?? currentRoot;
  const boardPath = path.join(repoRoot, BOARD_DIRECTORY);
  const localBranchExists = refExists(currentRoot, DATA_BRANCH_REF);
  const boardWorktree =
    worktrees.find((worktree) => worktree.path === canonicalPath(boardPath)) ??
    null;

  const report: DoctorReport = {
    ...empty,
    currentRoot,
    repoRoot,
    boardPath,
    localBranchExists,
    boardWorktree,
  };

  if (currentRoot !== repoRoot) {
    return withIssue(report, {
      code: "E_NOT_PRIMARY_WORKTREE",
      message: `Initialization is restricted to the primary worktree: ${repoRoot}`,
      recovery: `cd ${quoteForDisplay(repoRoot)} && localjira doctor`,
    });
  }

  const pathIssue = inspectBoardPath(boardPath, boardWorktree);
  if (pathIssue) {
    return withIssue(report, pathIssue);
  }

  if (!localBranchExists && !existsSync(boardPath)) {
    return { ...report, status: "UNINITIALIZED" };
  }

  if (localBranchExists && !boardWorktree) {
    return withIssue(report, {
      code: "E_INCOMPLETE_BOARD",
      message: `${DATA_BRANCH} exists but ${boardPath} is not attached.`,
      recovery: "Run localjira repair-worktree after reviewing localjira doctor.",
    });
  }

  if (boardWorktree?.branch !== DATA_BRANCH_REF) {
    return withIssue(report, {
      code: "E_WRONG_WORKTREE_BRANCH",
      message: `${boardPath} is attached to ${boardWorktree?.branch ?? "detached HEAD"}, not ${DATA_BRANCH_REF}.`,
      recovery: "Do not remove it automatically; inspect the worktree and choose the correct path.",
    });
  }

  report.codeIgnoreConfigured = hasIgnoreRule(
    path.join(repoRoot, ".gitignore"),
    "/.localjira/",
  );
  report.dataIgnoreConfigured = hasIgnoreRule(
    path.join(boardPath, ".gitignore"),
    "/.local/",
  );
  report.requiredFiles = Object.fromEntries(
    REQUIRED_FILES.map((file) => [file, existsSync(path.join(boardPath, file))]),
  );

  const missing = Object.entries(report.requiredFiles)
    .filter(([, present]) => !present)
    .map(([file]) => file);
  const issues: DiagnosticIssue[] = [];

  if (!report.codeIgnoreConfigured) {
    issues.push({
      code: "E_INCOMPLETE_BOARD",
      message: "The code worktree does not ignore /.localjira/.",
      recovery: "Add the root-anchored rule /.localjira/ to the code .gitignore.",
    });
  }
  if (!report.dataIgnoreConfigured) {
    issues.push({
      code: "E_INCOMPLETE_BOARD",
      message: "The data worktree does not ignore /.local/.",
      recovery: "Add the root-anchored rule /.local/ to .localjira/.gitignore.",
    });
  }
  if (missing.length > 0) {
    issues.push({
      code: "E_INCOMPLETE_BOARD",
      message: `Required tracked files are missing: ${missing.join(", ")}`,
      recovery: "Run localjira init with the original project arguments.",
    });
  }

  if (issues.length > 0) {
    return { ...report, status: "E_INCOMPLETE_BOARD", issues };
  }

  return { ...report, status: "READY", ok: true };
}

function inspectBoardPath(
  boardPath: string,
  boardWorktree: Worktree | null,
): DiagnosticIssue | null {
  if (!existsSync(boardPath)) {
    return null;
  }

  const stat = lstatSync(boardPath);
  if (stat.isSymbolicLink()) {
    let target = "unresolved";
    try {
      target = realpathSync.native(boardPath);
    } catch {
      // Keep the unresolved marker for broken links.
    }
    return {
      code: "E_UNSAFE_BOARD_PATH",
      message: `${boardPath} is a symbolic link (${target}).`,
      recovery: "Move the link manually after confirming its target; Local Jira will not overwrite it.",
    };
  }

  if (!stat.isDirectory() || !boardWorktree) {
    return {
      code: "E_BOARD_PATH_OCCUPIED",
      message: `${boardPath} exists but is not the registered Local Jira worktree.`,
      recovery: "Preserve and inspect the existing path; Local Jira will not rename or delete it.",
    };
  }

  return null;
}

function hasIgnoreRule(file: string, expected: string): boolean {
  if (!existsSync(file)) {
    return false;
  }

  const normalizedExpected = normalizeIgnoreRule(expected);
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .some((line) => normalizeIgnoreRule(line) === normalizedExpected);
}

function normalizeIgnoreRule(rule: string): string {
  const withoutNegation = rule.startsWith("!") ? rule : rule;
  return withoutNegation.replace(/\/+$/, "");
}

function withIssue(
  report: DoctorReport,
  issue: DiagnosticIssue,
): DoctorReport {
  return {
    ...report,
    status: issue.code,
    ok: false,
    issues: [...report.issues, issue],
  };
}

function emptyReport(): DoctorReport {
  return {
    status: "UNINITIALIZED",
    ok: false,
    currentRoot: null,
    repoRoot: null,
    boardPath: null,
    branch: DATA_BRANCH,
    localBranchExists: false,
    boardWorktree: null,
    codeIgnoreConfigured: false,
    dataIgnoreConfigured: false,
    requiredFiles: {},
    issues: [],
  };
}

function quoteForDisplay(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}
