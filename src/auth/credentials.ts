import { DatabaseSync } from "node:sqlite";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CREDENTIALS_FILENAME = "credentials.sqlite";
/** S1-D10: 12 hours, slid forward on use. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_TOKEN_BYTES = 32;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS credentials (
  user_id       TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
`;

export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}

/**
 * Credentials live outside the board tree, in `.local/`.
 *
 * That is a storage-layout decision, not a preference: `.localjira/` is a git
 * worktree that gets pushed, so a password hash placed there would travel to
 * everyone with the repository. Keeping it in the ignored directory makes the
 * accident structurally impossible rather than merely discouraged (PRD N6).
 */
export class CredentialStore {
  readonly path: string;
  #db: DatabaseSync;

  constructor(localDirectory: string) {
    fs.mkdirSync(localDirectory, { recursive: true });
    this.path = path.join(localDirectory, CREDENTIALS_FILENAME);
    this.#db = new DatabaseSync(this.path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(SCHEMA);
    restrictPermissions(this.path);
  }

  close(): void {
    this.#db.close();
  }

  hasAny(): boolean {
    const row = this.#db.prepare("SELECT COUNT(*) c FROM credentials").get() as { c: number };
    return Number(row.c) > 0;
  }

  has(userId: string): boolean {
    return (
      this.#db.prepare("SELECT 1 FROM credentials WHERE user_id = ?").get(userId) !==
      undefined
    );
  }

  setPassword(userId: string, passwordHash: string): void {
    this.#db
      .prepare(
        `INSERT INTO credentials(user_id, password_hash, updated_at) VALUES(?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash,
                                            updated_at = excluded.updated_at`,
      )
      .run(userId, passwordHash, Date.now());
  }

  passwordHash(userId: string): string | null {
    const row = this.#db
      .prepare("SELECT password_hash FROM credentials WHERE user_id = ?")
      .get(userId) as { password_hash?: string } | undefined;
    return row?.password_hash ?? null;
  }

  /**
   * Issues a session. Only the hash of the token is stored, so a leaked
   * database cannot be replayed as a live session.
   */
  createSession(userId: string, now: number = Date.now()): Session {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    const expiresAt = now + SESSION_TTL_MS;

    this.#db
      .prepare(
        "INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)",
      )
      .run(hashToken(token), userId, now, expiresAt);

    return { token, userId, expiresAt };
  }

  /** Returns the session and slides its expiry forward, or null. */
  touchSession(token: string, now: number = Date.now()): Session | null {
    const tokenHash = hashToken(token);
    const row = this.#db
      .prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?")
      .get(tokenHash) as { user_id: string; expires_at: number } | undefined;

    if (!row) {
      return null;
    }
    if (Number(row.expires_at) <= now) {
      this.#db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      return null;
    }

    const expiresAt = now + SESSION_TTL_MS;
    this.#db
      .prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?")
      .run(expiresAt, tokenHash);

    return { token, userId: row.user_id, expiresAt };
  }

  destroySession(token: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  destroySessionsFor(userId: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  purgeExpired(now: number = Date.now()): number {
    const before = this.#db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number };
    this.#db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    const after = this.#db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number };
    return Number(before.c) - Number(after.c);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Compares two secrets without leaking their relationship through timing. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function restrictPermissions(target: string): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Best effort; the file's location is what keeps it out of git.
  }
}
