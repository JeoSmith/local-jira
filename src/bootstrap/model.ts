export const DATA_BRANCH = "localjira/data";
export const DATA_BRANCH_REF = `refs/heads/${DATA_BRANCH}`;
export const BOARD_DIRECTORY = ".localjira";

export type DiagnosticCode =
  | "READY"
  | "UNINITIALIZED"
  | "E_NOT_GIT_REPOSITORY"
  | "E_NOT_PRIMARY_WORKTREE"
  | "E_UNSAFE_BOARD_PATH"
  | "E_BOARD_PATH_OCCUPIED"
  | "E_BRANCH_CHECKED_OUT"
  | "E_WRONG_WORKTREE_BRANCH"
  | "E_INCOMPLETE_BOARD"
  | "E_PARTIAL_BOOTSTRAP";

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface DiagnosticIssue {
  code: Exclude<DiagnosticCode, "READY" | "UNINITIALIZED">;
  message: string;
  recovery?: string;
}

export interface DoctorReport {
  status: DiagnosticCode;
  ok: boolean;
  currentRoot: string | null;
  repoRoot: string | null;
  boardPath: string | null;
  branch: typeof DATA_BRANCH;
  localBranchExists: boolean;
  boardWorktree: Worktree | null;
  codeIgnoreConfigured: boolean;
  dataIgnoreConfigured: boolean;
  requiredFiles: Record<string, boolean>;
  issues: DiagnosticIssue[];
}
