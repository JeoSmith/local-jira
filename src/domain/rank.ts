/**
 * Lexicographic ranks for backlog and board ordering (ADR-005, S1-D13).
 *
 * The parameters are fixed data-format decisions, not tuning knobs: two clones
 * must produce the same rank from the same request, and a rebalance must
 * produce the same result everywhere it runs. Changing any of them changes what
 * is written to files and needs a `schema_version` bump and a migration.
 *
 * Lower case only. Mixing cases would make the ordering depend on locale and on
 * whichever filesystem or collation happened to sort it.
 */
export const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = ALPHABET.length;
const MID_DIGIT = BASE / 2;

/** Where a first item lands, leaving room on both sides without a rebalance. */
export const INITIAL_RANK = "hzzzzz";

/** Ranks longer than this trigger a rebalance instead of growing further. */
export const MAX_RANK_LENGTH = 32;

/** How far either side of the collision the rebalance reaches (S1-D13). */
export const REBALANCE_SPAN = 64;

export class RankSpaceExhausted extends Error {
  readonly code = "E_RANK_SPACE_EXHAUSTED";
  readonly before: string | null;
  readonly after: string | null;

  constructor(before: string | null, after: string | null) {
    super(`No rank fits between ${before ?? "(start)"} and ${after ?? "(end)"}.`);
    this.name = "RankSpaceExhausted";
    this.before = before;
    this.after = after;
  }
}

export function isRank(value: string): boolean {
  return value.length > 0 && [...value].every((char) => ALPHABET.includes(char));
}

/**
 * A rank that sorts strictly between the two neighbours.
 *
 * `null` means "no neighbour on that side", which is a different thing from an
 * empty rank: the top of the list has nothing before it, and the value chosen
 * still has to leave room for the next insertion above it.
 *
 * Throws `RankSpaceExhausted` when the gap has run out or the result would
 * exceed the length limit. That is not a failure to handle here — it is the
 * signal the caller needs to rebalance the region (ADR-005 §3).
 */
export function between(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) {
    throw new RankSpaceExhausted(before, after);
  }
  if (before === null && after === null) {
    return INITIAL_RANK;
  }

  const lower = before === null ? [] : digitsOf(before);
  const upper = after === null ? null : digitsOf(after);
  const candidate = trim(midpoint(lower, upper));
  const rank = candidate.map((digit) => ALPHABET[digit]).join("");

  if (rank.length > MAX_RANK_LENGTH) {
    throw new RankSpaceExhausted(before, after);
  }
  if ((before !== null && rank <= before) || (after !== null && rank >= after)) {
    // The neighbours are adjacent in the string space: nothing sorts between
    // them however many digits are added.
    throw new RankSpaceExhausted(before, after);
  }
  return rank;
}

/**
 * Evenly spaced ranks for a region being rebalanced.
 *
 * Deterministic by construction — same count, same bounds, same output on every
 * clone — which is what lets two nodes rebalance the same region independently
 * and converge instead of fighting.
 */
export function spread(count: number, before: string | null, after: string | null): string[] {
  if (count <= 0) {
    return [];
  }

  const lower = before === null ? [] : digitsOf(before);
  const upper = after === null ? null : digitsOf(after);

  // Work at a width that leaves room for `count` distinct values between the
  // bounds, so the gaps come out even rather than crowding at one end.
  const width = Math.max(
    INITIAL_RANK.length,
    lower.length,
    upper?.length ?? 0,
    requiredWidth(count),
  );

  const start = valueAt(lower, width, 0);
  const top = upper === null ? maxValue(width) : valueAt(upper, width, 0);
  const step = (top - start) / BigInt(count + 1);

  if (step <= 0n) {
    throw new RankSpaceExhausted(before, after);
  }

  const ranks: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    ranks.push(render(start + step * BigInt(index), width));
  }
  return ranks;
}

/** Digits of a rank, most significant first. */
function digitsOf(rank: string): number[] {
  return [...rank].map((char) => {
    const digit = ALPHABET.indexOf(char);
    if (digit === -1) {
      throw new RankSpaceExhausted(rank, null);
    }
    return digit;
  });
}

function midpoint(lower: number[], upper: number[] | null): number[] {
  const width = Math.max(lower.length, upper?.length ?? 0) + 1;
  const a = pad(lower, width, 0);
  const b = upper === null ? pad([], width, BASE - 1) : pad(upper, width, 0);

  // Sum, then halve. Done digit by digit so the result never goes through a
  // float, where the precision would run out long before the string space does.
  const sum = new Array<number>(width + 1).fill(0);
  let carry = 0;
  for (let index = width - 1; index >= 0; index -= 1) {
    const total = a[index] + b[index] + carry;
    sum[index + 1] = total % BASE;
    carry = Math.floor(total / BASE);
  }
  sum[0] = carry;

  const halved: number[] = [];
  let remainder = 0;
  for (const digit of sum) {
    const current = remainder * BASE + digit;
    halved.push(Math.floor(current / 2));
    remainder = current % 2;
  }
  if (remainder > 0) {
    halved.push(MID_DIGIT);
  }
  return halved.slice(1);
}

function pad(digits: number[], width: number, filler: number): number[] {
  const out = digits.slice(0, width);
  while (out.length < width) {
    out.push(filler);
  }
  return out;
}

/** Drops trailing zeros, which carry no ordering information. */
function trim(digits: number[]): number[] {
  const out = [...digits];
  while (out.length > 1 && out[out.length - 1] === 0) {
    out.pop();
  }
  return out;
}

function requiredWidth(count: number): number {
  let width = 1;
  while (BASE ** width < count + 2 && width < MAX_RANK_LENGTH) {
    width += 1;
  }
  return width + 1;
}

function valueAt(digits: number[] | null, width: number, filler: number): bigint {
  const padded = pad(digits ?? [], width, filler);
  let value = 0n;
  for (const digit of padded) {
    value = value * BigInt(BASE) + BigInt(digit);
  }
  return value;
}

function maxValue(width: number): bigint {
  return BigInt(BASE) ** BigInt(width) - 1n;
}

function render(value: bigint, width: number): string {
  const digits: string[] = [];
  let remaining = value;
  for (let index = 0; index < width; index += 1) {
    digits.unshift(ALPHABET[Number(remaining % BigInt(BASE))]);
    remaining /= BigInt(BASE);
  }
  return trimTrailingZeros(digits.join(""));
}

function trimTrailingZeros(rank: string): string {
  let end = rank.length;
  while (end > 1 && rank[end - 1] === "0") {
    end -= 1;
  }
  return rank.slice(0, end);
}
