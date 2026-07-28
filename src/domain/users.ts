import fs from "node:fs";
import path from "node:path";

import { yamlScalar } from "../bootstrap/scaffold.ts";
import { CredentialStore } from "../auth/credentials.ts";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import type { BoardHandle } from "../storage/board.ts";
import { incrementalSync } from "../storage/reindex.ts";
import { parseYamlResource } from "../storage/resource.ts";

export const USERS_FILE = "users.yaml";
export const ROLES = ["admin", "member", "agent"] as const;
export type Role = (typeof ROLES)[number];

const USER_ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

export type UserErrorCode =
  | "E_INVALID_USER_ID"
  | "E_INVALID_DISPLAY_NAME"
  | "E_INVALID_ROLE"
  | "E_USER_EXISTS"
  | "E_LAST_ADMIN"
  | "E_ALREADY_BOOTSTRAPPED";

export class UserError extends Error {
  readonly code: UserErrorCode;
  readonly detail: string | null;

  constructor(code: UserErrorCode, message: string, detail: string | null = null) {
    super(message);
    this.name = "UserError";
    this.code = code;
    this.detail = detail;
  }
}

export interface UserRecord {
  id: string;
  displayName: string;
  role: Role;
}

export interface CreateUserInput {
  id: string;
  displayName: string;
  role: Role;
  password: string;
}

export function listUsers(board: BoardHandle): UserRecord[] {
  return (
    board.db
      .prepare("SELECT id, display_name, role FROM users ORDER BY id")
      .all() as Array<{ id: string; display_name: string | null; role: string | null }>
  )
    // A row with a role outside the fixed three is not loaded. Guessing a
    // default would silently grant or withhold permission based on a typo.
    .filter((row) => (ROLES as readonly string[]).includes(row.role ?? ""))
    .map((row) => ({
      id: row.id,
      displayName: row.display_name ?? row.id,
      role: row.role as Role,
    }));
}

/** Accounts whose `role` the board refused to load. */
export function invalidUsers(board: BoardHandle): Array<{ id: string; role: string | null }> {
  return (
    board.db
      .prepare("SELECT id, role FROM users ORDER BY id")
      .all() as Array<{ id: string; role: string | null }>
  )
    .filter((row) => !(ROLES as readonly string[]).includes(row.role ?? ""))
    // node:sqlite hands back null-prototype rows; returning them from a public
    // function makes every caller's deepEqual and spread behave oddly.
    .map((row) => ({ id: row.id, role: row.role ?? null }));
}

/**
 * Changes a role in place.
 *
 * The last admin cannot be demoted. A board with no admin can never regain
 * one through the API, so the only recovery would be editing files by hand —
 * a state the product should not be able to enter on its own.
 */
export function changeRole(
  board: BoardHandle,
  userId: string,
  role: Role,
): { from: Role; to: Role } {
  const users = listUsers(board);
  const user = users.find((candidate) => candidate.id === userId);
  if (!user) {
    throw new UserError("E_USER_EXISTS", `No user "${userId}"`);
  }
  requireRole(role);

  if (user.role === "admin" && role !== "admin" && countAdmins(users) === 1) {
    throw new UserError(
      "E_LAST_ADMIN",
      "This is the only admin; demoting it would leave the board without one.",
      "Promote another account first.",
    );
  }

  const next = users.map((candidate) =>
    candidate.id === userId ? { ...candidate, role } : candidate,
  );
  writeUsersFile(board.boardRoot, next);
  incrementalSync(board.boardRoot, board.db);

  return { from: user.role, to: role };
}

function countAdmins(users: UserRecord[]): number {
  return users.filter((user) => user.role === "admin").length;
}

/** True while the board has no accounts and every domain call must be 401. */
export function needsBootstrap(board: BoardHandle): boolean {
  return listUsers(board).length === 0;
}

export function bootstrapAdmin(
  board: BoardHandle,
  input: Omit<CreateUserInput, "role">,
): UserRecord {
  if (!needsBootstrap(board)) {
    throw new UserError(
      "E_ALREADY_BOOTSTRAPPED",
      "This board already has accounts",
      "Sign in as an existing admin to add more.",
    );
  }
  return createUser(board, { ...input, role: "admin" });
}

/**
 * Adds an account.
 *
 * The split is the point of the story: identity goes to `users.yaml`, which is
 * tracked and shared, while the password hash goes to `.local/`, which is not.
 * A teammate who clones the board sees who exists but cannot sign in as them.
 */
export function createUser(
  board: BoardHandle,
  input: CreateUserInput,
): UserRecord {
  const id = requireUserId(input.id);
  const displayName = requireDisplayName(input.displayName);
  const role = requireRole(input.role);

  if (listUsers(board).some((user) => user.id === id)) {
    throw new UserError("E_USER_EXISTS", `A user "${id}" already exists`);
  }

  // Hash before touching any file so a rejected password leaves no trace.
  const passwordHash = hashPassword(input.password);

  appendUserToFile(board.boardRoot, { id, displayName, role });
  incrementalSync(board.boardRoot, board.db);

  const store = new CredentialStore(board.localDirectory);
  try {
    store.setPassword(id, passwordHash);
  } finally {
    store.close();
  }

  return { id, displayName, role };
}

export interface AuthOutcome {
  user: UserRecord | null;
  /** Distinguishes "no credentials on this machine" from a wrong password. */
  reason: "ok" | "unknown_user" | "no_local_credentials" | "bad_password";
}

/**
 * Verifies a password.
 *
 * A missing account still runs a hash so that a wrong identifier and a wrong
 * password take the same time; otherwise the response latency would enumerate
 * valid user ids.
 */
export function authenticate(
  board: BoardHandle,
  store: CredentialStore,
  userId: string,
  password: string,
): AuthOutcome {
  const user = listUsers(board).find((candidate) => candidate.id === userId) ?? null;
  const hash = user ? store.passwordHash(user.id) : null;

  if (!hash) {
    // Same cost as the real path, and the result is discarded.
    verifyPassword(password, DUMMY_HASH);
    if (!user) {
      return { user: null, reason: "unknown_user" };
    }
    return { user: null, reason: "no_local_credentials" };
  }

  return verifyPassword(password, hash)
    ? { user, reason: "ok" }
    : { user: null, reason: "bad_password" };
}

/** A fixed, valid hash used only to equalise timing on the failure path. */
const DUMMY_HASH = hashPassword("localjira-timing-equaliser");

function appendUserToFile(boardRoot: string, user: UserRecord): void {
  const target = path.join(boardRoot, USERS_FILE);
  const existing = fs.existsSync(target)
    ? (parseYamlResource(fs.readFileSync(target)).frontmatter as Record<string, unknown>)
    : { users: [] };

  const entries = (Array.isArray(existing.users) ? existing.users : []) as Array<
    Record<string, unknown>
  >;
  writeUsersFile(boardRoot, [
    ...entries.map((entry) => ({
      id: String(entry.id ?? ""),
      displayName: String(entry.display_name ?? ""),
      role: String(entry.role ?? "member") as Role,
    })),
    user,
  ]);
}

function writeUsersFile(boardRoot: string, users: UserRecord[]): void {
  const lines = ["schema_version: 1", "users:"];
  for (const user of users) {
    lines.push(`  - id: ${yamlScalar(user.id)}`);
    lines.push(`    display_name: ${yamlScalar(user.displayName)}`);
    lines.push(`    role: ${user.role}`);
  }
  writeFileAtomic(path.join(boardRoot, USERS_FILE), `${lines.join("\n")}\n`);
}

function requireUserId(value: string): string {
  if (!USER_ID_PATTERN.test(value)) {
    throw new UserError(
      "E_INVALID_USER_ID",
      `"${value}" is not a valid user id`,
      "Use 2-32 characters: lowercase letters, digits, underscore or hyphen, starting with a letter.",
    );
  }
  return value;
}

function requireDisplayName(value: string): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "" || [...trimmed].length > 100) {
    throw new UserError(
      "E_INVALID_DISPLAY_NAME",
      "A display name must be 1-100 characters",
    );
  }
  return trimmed;
}

function requireRole(value: string): Role {
  if (!(ROLES as readonly string[]).includes(value)) {
    throw new UserError("E_INVALID_ROLE", `"${value}" is not a role`, `Allowed: ${ROLES.join(", ")}`);
  }
  return value as Role;
}

function writeFileAtomic(target: string, contents: string): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.tmp`);

  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, "w", 0o644);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, target);
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
