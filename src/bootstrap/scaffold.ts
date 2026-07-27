import fs from "node:fs";
import path from "node:path";

import { createUlid, isUlid } from "./identifier.ts";
import type { ProjectInput } from "./input.ts";

export const SCHEMA_VERSION = 1;
export const LOCAL_DIRECTORY = ".local";
export const NODE_IDENTITY_FILENAME = "node.yaml";

const LOCAL_DIRECTORY_MODE = 0o700;
const LOCAL_FILE_MODE = 0o600;

export interface ScaffoldOptions extends ProjectInput {
  boardId?: string;
  createdAt?: string;
}

export interface ScaffoldResult {
  boardId: string;
  created: string[];
  preserved: string[];
}

export interface NodeIdentity {
  nodeId: string;
  createdAt: string;
  created: boolean;
}

/**
 * Writes the tracked files of a fresh board (design §6.1).
 *
 * Existing files are preserved byte-for-byte. Re-running init must never
 * rewrite a file just to normalise its formatting — that would show up as a
 * spurious diff on a shared branch.
 */
export function writeInitialScaffold(
  boardPath: string,
  options: ScaffoldOptions,
): ScaffoldResult {
  const createdAt = options.createdAt ?? utcTimestamp();
  const boardId = options.boardId ?? createUlid();

  const files: Array<[string, string]> = [
    [".gitattributes", renderGitattributes()],
    [".gitignore", renderDataGitignore()],
    ["config.yaml", renderConfigYaml(boardId, options.projectKey, createdAt)],
    ["users.yaml", renderUsersYaml()],
    [
      path.join("projects", `${options.projectKey}.yaml`),
      renderProjectYaml(options, createdAt),
    ],
  ];

  const created: string[] = [];
  const preserved: string[] = [];

  for (const [relativePath, contents] of files) {
    const target = path.join(boardPath, relativePath);
    if (fs.existsSync(target)) {
      preserved.push(relativePath);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, contents);
    created.push(relativePath);
  }

  return { boardId, created, preserved };
}

/**
 * Creates `.local/node.yaml` if absent (design §6.2).
 *
 * The node id seeds event filenames and the SSE epoch, so reissuing one on an
 * existing installation would fork the event stream. An existing file is only
 * validated, never replaced.
 */
export function ensureNodeIdentity(
  boardPath: string,
  now: string = utcTimestamp(),
): NodeIdentity {
  const localDirectory = path.join(boardPath, LOCAL_DIRECTORY);
  const target = path.join(localDirectory, NODE_IDENTITY_FILENAME);

  fs.mkdirSync(localDirectory, { recursive: true });
  applyMode(localDirectory, LOCAL_DIRECTORY_MODE);

  if (fs.existsSync(target)) {
    const existing = readNodeIdentity(target);
    applyMode(target, LOCAL_FILE_MODE);
    return { ...existing, created: false };
  }

  const nodeId = createUlid();
  writeFileAtomic(target, renderNodeIdentityYaml(nodeId, now), LOCAL_FILE_MODE);
  return { nodeId, createdAt: now, created: true };
}

export function readNodeIdentity(target: string): {
  nodeId: string;
  createdAt: string;
} {
  const contents = fs.readFileSync(target, "utf8");
  const nodeId = matchScalar(contents, "node_id");
  const createdAt = matchScalar(contents, "created_at");

  if (!nodeId || !isUlid(nodeId)) {
    throw new Error(`${target} does not contain a valid ULID node_id.`);
  }
  if (!createdAt) {
    throw new Error(`${target} does not contain created_at.`);
  }
  return { nodeId, createdAt };
}

export function renderConfigYaml(
  boardId: string,
  defaultProject: string,
  createdAt: string,
): string {
  return yamlDocument([
    `schema_version: ${SCHEMA_VERSION}`,
    `board_id: ${boardId}`,
    `created_at: ${createdAt}`,
    `default_project: ${defaultProject}`,
  ]);
}

export function renderProjectYaml(
  project: ProjectInput,
  createdAt: string,
): string {
  return yamlDocument([
    `schema_version: ${SCHEMA_VERSION}`,
    `key: ${project.projectKey}`,
    `name: ${yamlScalar(project.projectName)}`,
    `timezone: ${yamlScalar(project.timezone)}`,
    "estimation_unit: story_points",
    `created_at: ${createdAt}`,
  ]);
}

export function renderUsersYaml(): string {
  return yamlDocument([`schema_version: ${SCHEMA_VERSION}`, "users: []"]);
}

export function renderNodeIdentityYaml(
  nodeId: string,
  createdAt: string,
): string {
  return yamlDocument([
    `schema_version: ${SCHEMA_VERSION}`,
    `node_id: ${nodeId}`,
    `created_at: ${createdAt}`,
  ]);
}

export function renderGitattributes(): string {
  return yamlDocument([
    "* text=auto",
    "*.md text eol=lf",
    "*.yaml text eol=lf",
    "*.yml text eol=lf",
    "*.json text eol=lf",
    "*.jsonl text eol=lf",
  ]);
}

export function renderDataGitignore(): string {
  return yamlDocument(["/.local/"]);
}

export function utcTimestamp(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

/**
 * Quotes only when a bare scalar would be ambiguous. Keeps generated YAML close
 * to what a person would have typed while staying unambiguous for the parser.
 */
export function yamlScalar(value: string): string {
  const needsQuoting =
    value.length === 0 ||
    value !== value.trim() ||
    // Indicator characters are only special as the first character.
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    // A colon ends a key when followed by whitespace or end of scalar.
    /:(\s|$)/.test(value) ||
    // A comment starts at "#" only when preceded by whitespace.
    /\s#/.test(value) ||
    /[\n\r\t]/.test(value) ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(value) ||
    /^[-+]?(\d|\.\d)/.test(value);

  if (!needsQuoting) {
    return value;
  }
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function yamlDocument(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

/**
 * temp file in the same directory → fsync → rename → fsync(parent).
 * Same durability sequence the storage layer uses for domain files, so a crash
 * mid-write cannot leave a half-written YAML file behind.
 */
function writeFileAtomic(target: string, contents: string, mode?: number): void {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.tmp`,
  );

  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, "w", mode ?? 0o644);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    if (mode !== undefined) {
      applyMode(temporary, mode);
    }
    fs.renameSync(temporary, target);
    syncDirectory(directory);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The original error is the one worth reporting.
      }
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function syncDirectory(directory: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is unavailable on some filesystems; the rename itself is
    // still atomic, so this is a durability nicety rather than a correctness
    // requirement.
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

function applyMode(target: string, mode: number): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Best effort: a filesystem that ignores POSIX modes should not stop
    // bootstrap. The design asks for these modes, it does not depend on them.
  }
}

function matchScalar(contents: string, key: string): string | null {
  const match = contents.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim().replace(/^"(.*)"$/, "$1") : null;
}
