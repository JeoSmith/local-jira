import { argon2Sync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Password hashing (PRD N6).
 *
 * argon2id comes from Node's own crypto module — no dependency, and the
 * algorithm the requirement names rather than a substitute. Parameters follow
 * the OWASP baseline: 64 MiB, three passes, one lane.
 */
export const ARGON2_ALGORITHM = "argon2id";
export const ARGON2_MEMORY_KIB = 65_536;
export const ARGON2_PASSES = 3;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_TAG_BYTES = 32;
export const NONCE_BYTES = 16;

export const MIN_PASSWORD_LENGTH = 8;

export class PasswordError extends Error {
  readonly code = "E_INVALID_PASSWORD";

  constructor(message: string) {
    super(message);
    this.name = "PasswordError";
  }
}

/**
 * Encoded as `argon2id$v=<m>,<t>,<p>$<nonce>$<tag>`, all base64url.
 *
 * The parameters travel with the hash so raising them later does not
 * invalidate existing passwords — an old hash still verifies under the
 * settings it was made with.
 */
export function hashPassword(password: string): string {
  requireAcceptable(password);
  const nonce = randomBytes(NONCE_BYTES);
  const tag = derive(password, nonce, {
    memory: ARGON2_MEMORY_KIB,
    passes: ARGON2_PASSES,
    parallelism: ARGON2_PARALLELISM,
  });

  return [
    ARGON2_ALGORITHM,
    `v=${ARGON2_MEMORY_KIB},${ARGON2_PASSES},${ARGON2_PARALLELISM}`,
    nonce.toString("base64url"),
    tag.toString("base64url"),
  ].join("$");
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parsed = parse(encoded);
  if (!parsed) {
    return false;
  }

  let candidate: Buffer;
  try {
    candidate = derive(password, parsed.nonce, parsed.params);
  } catch {
    return false;
  }

  return (
    candidate.length === parsed.tag.length &&
    // Constant time so a wrong password cannot be narrowed down by timing.
    timingSafeEqual(candidate, parsed.tag)
  );
}

interface Params {
  memory: number;
  passes: number;
  parallelism: number;
}

function derive(password: string, nonce: Buffer, params: Params): Buffer {
  return argon2Sync(ARGON2_ALGORITHM, {
    message: Buffer.from(password, "utf8"),
    nonce,
    tagLength: ARGON2_TAG_BYTES,
    memory: params.memory,
    passes: params.passes,
    parallelism: params.parallelism,
  });
}

function parse(
  encoded: string,
): { nonce: Buffer; tag: Buffer; params: Params } | null {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== ARGON2_ALGORITHM) {
    return null;
  }

  const match = /^v=(\d+),(\d+),(\d+)$/.exec(parts[1]);
  if (!match) {
    return null;
  }

  return {
    params: {
      memory: Number(match[1]),
      passes: Number(match[2]),
      parallelism: Number(match[3]),
    },
    nonce: Buffer.from(parts[2], "base64url"),
    tag: Buffer.from(parts[3], "base64url"),
  };
}

function requireAcceptable(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordError(
      `A password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
}
