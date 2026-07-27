import path from "node:path";

export const BOARD_DIRECTORY = ".localjira";
export const LOCAL_DIRECTORY = ".local";

/** File kinds tracked in `file_state`. Every SoT file has one (design §3.3). */
export type FileKind =
  | "config"
  | "users"
  | "project"
  | "issue"
  | "comment"
  | "comment_ops"
  | "sprint"
  | "run"
  | "proposal"
  | "event";

export interface FileIdentity {
  /** Board-relative path with forward slashes, the primary key everywhere. */
  path: string;
  kind: FileKind;
  project: string | null;
  /** Issue key for comment files, sprint id for sprints, and so on. */
  owner: string | null;
}

/** Directories that never hold domain data. */
const EXCLUDED = new Set([LOCAL_DIRECTORY, ".git"]);

export function isExcluded(relativePath: string): boolean {
  const [head] = relativePath.split("/");
  return EXCLUDED.has(head);
}

export function toBoardPath(boardRoot: string, absolute: string): string {
  return path.relative(boardRoot, absolute).split(path.sep).join("/");
}

/**
 * Classifies a board-relative path.
 *
 * Path shape is the only classifier: a file that does not match a known
 * location is not domain data, so it is ignored rather than guessed at. That
 * keeps a stray README or editor backup from being indexed as an issue.
 */
export function classify(relativePath: string): FileIdentity | null {
  if (isExcluded(relativePath)) {
    return null;
  }

  const segments = relativePath.split("/");
  const file = segments[segments.length - 1];

  if (segments.length === 1) {
    if (file === "config.yaml") {
      return { path: relativePath, kind: "config", project: null, owner: null };
    }
    if (file === "users.yaml") {
      return { path: relativePath, kind: "users", project: null, owner: null };
    }
    return null;
  }

  const [root] = segments;

  if (root === "projects" && segments.length === 2 && file.endsWith(".yaml")) {
    const key = file.slice(0, -".yaml".length);
    return { path: relativePath, kind: "project", project: key, owner: key };
  }

  if (root === "issues" && segments.length === 3 && file.endsWith(".md")) {
    return {
      path: relativePath,
      kind: "issue",
      project: segments[1],
      owner: file.slice(0, -".md".length),
    };
  }

  if (root === "comments" && segments.length === 3) {
    const issueKey = segments[1];
    if (file.endsWith(".ops.jsonl")) {
      return {
        path: relativePath,
        kind: "comment_ops",
        project: projectOfKey(issueKey),
        owner: file.slice(0, -".ops.jsonl".length),
      };
    }
    if (file.endsWith(".md")) {
      return {
        path: relativePath,
        kind: "comment",
        project: projectOfKey(issueKey),
        owner: file.slice(0, -".md".length),
      };
    }
    return null;
  }

  if (root === "sprints" && segments.length === 3 && file.endsWith(".yaml")) {
    return {
      path: relativePath,
      kind: "sprint",
      project: segments[1],
      owner: file.slice(0, -".yaml".length),
    };
  }

  if (root === "runs" && segments.length === 4 && file.endsWith(".json")) {
    return {
      path: relativePath,
      kind: "run",
      project: segments[1],
      owner: file.slice(0, -".json".length),
    };
  }

  if (root === "proposals" && segments.length === 3 && file.endsWith(".yaml")) {
    return {
      path: relativePath,
      kind: "proposal",
      project: segments[1],
      owner: file.slice(0, -".yaml".length),
    };
  }

  if (root === "events" && segments.length === 3 && file.endsWith(".jsonl")) {
    return {
      path: relativePath,
      kind: "event",
      project: null,
      owner: file.slice(0, -".jsonl".length),
    };
  }

  return null;
}

/** `LJ-12` → `LJ`. Comment directories are named by issue key. */
function projectOfKey(issueKey: string): string | null {
  const dash = issueKey.lastIndexOf("-");
  return dash > 0 ? issueKey.slice(0, dash) : null;
}

export function issuePath(project: string, key: string): string {
  return `issues/${project}/${key}.md`;
}

export function commentPath(issueKey: string, commentId: string): string {
  return `comments/${issueKey}/${commentId}.md`;
}

export function commentOpsPath(issueKey: string, commentId: string): string {
  return `comments/${issueKey}/${commentId}.ops.jsonl`;
}
