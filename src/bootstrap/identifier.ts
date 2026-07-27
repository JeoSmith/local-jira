import { randomFillSync } from "node:crypto";

/** Crockford base32, excluding I, L, O and U. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIMESTAMP_LENGTH = 10;
const RANDOMNESS_LENGTH = 16;
export const ULID_LENGTH = TIMESTAMP_LENGTH + RANDOMNESS_LENGTH;

const ULID_PATTERN = new RegExp(`^[${ENCODING}]{${ULID_LENGTH}}$`);
const MAX_TIMESTAMP = 2 ** 48 - 1;

/**
 * ULIDs are used for `board_id`, `node_id` and every domain uid. The first 48
 * bits are the timestamp, so lexical order is roughly creation order — which is
 * what makes rekeying deterministic across clones (ADR-006 D3).
 */
export function createUlid(now: number = Date.now()): string {
  const timestamp = Math.floor(now);
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > MAX_TIMESTAMP) {
    throw new RangeError(`Timestamp ${now} is outside the ULID range.`);
  }
  return encodeTimestamp(timestamp) + encodeRandomness();
}

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

function encodeTimestamp(timestamp: number): string {
  let remaining = timestamp;
  let encoded = "";
  for (let index = 0; index < TIMESTAMP_LENGTH; index += 1) {
    encoded = ENCODING[remaining % 32] + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

function encodeRandomness(): string {
  // One byte per character, taking the low 5 bits. Rejecting nothing keeps the
  // distribution uniform because 256 is not a multiple of 32 only in the high
  // bits, which are discarded identically for every value.
  const bytes = randomFillSync(new Uint8Array(RANDOMNESS_LENGTH));
  let encoded = "";
  for (const byte of bytes) {
    encoded += ENCODING[byte & 0x1f];
  }
  return encoded;
}
