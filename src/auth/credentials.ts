import { DatabaseSync } from "node:sqlite";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createUlid } from "../bootstrap/identifier.ts";

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
CREATE TABLE IF NOT EXISTS tokens (
  token_id      TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT,
  token_hash    TEXT NOT NULL UNIQUE,
  scopes        TEXT NOT NULL,
  project_scope TEXT,
  created_at    INTEGER NOT NULL,
  -- NULL means the token never expires (S3-D7). Allowed on purpose: a CI or a
  -- long-running daemon has nobody to renew it, and forcing an expiry there
  -- only creates a manual step that gets forgotten until the agent 401s at
  -- night. last_used_at is what makes an unused token findable instead.
  expires_at    INTEGER,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS ix_tokens_user ON tokens(user_id);
`;

export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}

/**
 * The prefix every personal access token carries.
 *
 * Present so a leaked string is recognisable as a credential — by a person
 * reading a log, and by the secret scanners that watch repositories for
 * exactly this kind of pattern.
 */
export const TOKEN_PREFIX = "ljp_";
const TOKEN_SECRET_BYTES = 32;
/** S3-D7: what an issue request gets when it does not say. */
export const TOKEN_DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** A token as anyone may see it. The secret is not part of it. */
export interface TokenRecord {
  tokenId: string;
  userId: string;
  name: string | null;
  scopes: string[];
  projectScope: string | null;
  createdAt: number;
  /** null when the token never expires (S3-D7). */
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** The one moment the plaintext exists outside the caller's hands. */
export interface IssuedToken {
  record: TokenRecord;
  token: string;
}

/** Why a presented token is not usable. Told apart for the audit, not the caller. */
export type TokenRejection = "unknown" | "revoked" | "expired";

export type TokenLookup =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: TokenRejection };

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

  /**
   * Issues a PAT, returning the plaintext exactly once.
   *
   * Only the hash is stored, for the same reason sessions are: a copy of this
   * database must not be replayable. The caller cannot ask for the plaintext
   * again because nothing here can produce it — that is the property N6 wants,
   * not a policy that a later route could relax.
   */
  createToken(input: {
    userId: string;
    name: string | null;
    scopes: string[];
    projectScope: string | null;
    /** null issues a token that never expires (S3-D7). */
    expiresAt: number | null;
    now?: number;
  }): IssuedToken {
    const now = input.now ?? Date.now();
    const token = TOKEN_PREFIX + randomBytes(TOKEN_SECRET_BYTES).toString("base64url");
    const tokenId = createUlid(now);

    this.#db
      .prepare(
        `INSERT INTO tokens(token_id, user_id, name, token_hash, scopes, project_scope,
                            created_at, expires_at, last_used_at, revoked_at)
         VALUES(?,?,?,?,?,?,?,?,NULL,NULL)`,
      )
      .run(
        tokenId, input.userId, input.name, hashToken(token),
        JSON.stringify(input.scopes), input.projectScope, now, input.expiresAt,
      );

    return {
      token,
      record: {
        tokenId,
        userId: input.userId,
        name: input.name,
        scopes: input.scopes,
        projectScope: input.projectScope,
        createdAt: now,
        expiresAt: input.expiresAt,
        lastUsedAt: null,
        revokedAt: null,
      },
    };
  }

  listTokens(userId?: string): TokenRecord[] {
    const rows = (
      userId === undefined
        ? this.#db.prepare("SELECT * FROM tokens ORDER BY created_at DESC").all()
        : this.#db
            .prepare("SELECT * FROM tokens WHERE user_id = ? ORDER BY created_at DESC")
            .all(userId)
    ) as TokenRow[];
    return rows.map(toTokenRecord);
  }

  findToken(tokenId: string): TokenRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM tokens WHERE token_id = ?")
      .get(tokenId) as TokenRow | undefined;
    return row ? toTokenRecord(row) : null;
  }

  /**
   * Revokes a token. Takes effect on the next request, not the next restart:
   * the check reads this row every time, so there is no cache to invalidate
   * (r13a AC6).
   */
  revokeToken(tokenId: string, now: number = Date.now()): boolean {
    const changed = this.#db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL")
      .run(now, tokenId);
    return Number(changed.changes) > 0;
  }

  /**
   * Resolves a presented token string.
   *
   * Revoked and expired are told apart from unknown because the audit trail
   * wants to distinguish "somebody is using a token we killed" from "somebody
   * is guessing". All three are 401 to the caller.
   */
  resolveToken(token: string, now: number = Date.now()): TokenLookup {
    const row = this.#db
      .prepare("SELECT * FROM tokens WHERE token_hash = ?")
      .get(hashToken(token)) as TokenRow | undefined;

    if (!row) {
      return { ok: false, reason: "unknown" };
    }
    if (row.revoked_at !== null) {
      return { ok: false, reason: "revoked" };
    }
    // A null `expires_at` never expires — see the schema comment (S3-D7).
    if (row.expires_at !== null && Number(row.expires_at) <= now) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, record: toTokenRecord(row) };
  }

  /**
   * Records that a token was used.
   *
   * Deliberately not an event: N7 excludes reads and searches from the audit,
   * and a token that only reads would otherwise write a file per request.
   * `last_used_at` is display state, and under S3-D7 it is also the only way
   * an unlimited token can be recognised as unused.
   */
  touchToken(tokenId: string, now: number = Date.now()): void {
    this.#db.prepare("UPDATE tokens SET last_used_at = ? WHERE token_id = ?").run(now, tokenId);
  }

  purgeExpired(now: number = Date.now()): number {
    const before = this.#db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number };
    this.#db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    const after = this.#db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number };
    return Number(before.c) - Number(after.c);
  }
}

interface TokenRow {
  token_id: string;
  user_id: string;
  name: string | null;
  scopes: string;
  project_scope: string | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

function toTokenRecord(row: TokenRow): TokenRecord {
  let scopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.scopes);
    scopes = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    // A row we cannot read the scopes of grants nothing. Failing open here
    // would turn a corrupt column into a wildcard.
    scopes = [];
  }

  return {
    tokenId: row.token_id,
    userId: row.user_id,
    name: row.name,
    scopes,
    projectScope: row.project_scope,
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
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
