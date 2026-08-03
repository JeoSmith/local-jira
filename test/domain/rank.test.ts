import assert from "node:assert/strict";
import test from "node:test";

import {
  ALPHABET,
  between,
  INITIAL_RANK,
  isRank,
  MAX_RANK_LENGTH,
  RankSpaceExhausted,
  spread,
} from "../../src/domain/rank.ts";

/**
 * Ranks are a stored format, so these are property tests rather than examples:
 * what matters is that *no* sequence of moves can produce an order that differs
 * between two clones, and a handful of hand-picked cases cannot say that.
 *
 * The generator is seeded and written out here rather than pulled from a
 * library — the project has no dependencies, and a fixed seed means a failure
 * reproduces exactly instead of "it went red once on CI".
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32: small, deterministic, and adequate for choosing indices.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

test("a rank sorts strictly between its neighbours", () => {
  const random = seeded(20260728);

  for (let trial = 0; trial < 500; trial += 1) {
    const first = between(null, null);
    let low = first;
    let high = between(low, null);

    for (let depth = 0; depth < 20; depth += 1) {
      const middle = between(low, high);
      assert.ok(low < middle, `${low} < ${middle} failed`);
      assert.ok(middle < high, `${middle} < ${high} failed`);
      assert.ok(isRank(middle), `${middle} left the alphabet`);

      if (random() < 0.5) {
        high = middle;
      } else {
        low = middle;
      }
    }
  }
});

test("a thousand inserts into one gap stay ordered, rebalancing as needed", () => {
  // The AC in full: not "1,000 inserts fit in the string space" — they do not,
  // the gap is exhausted after about fifty — but "the order is right after
  // every one of them". Running out is expected and is what rebalancing is for.
  let list = [between(null, null)];
  list.push(between(list[0], null));
  let rebalances = 0;

  for (let insert = 0; insert < 1_000; insert += 1) {
    let rank: string;
    try {
      rank = between(list[0], list[1]);
    } catch (error) {
      assert.ok(error instanceof RankSpaceExhausted, `unexpected ${String(error)}`);
      // What the server does with this signal: respread the region and retry.
      list = spread(list.length, null, null);
      rebalances += 1;
      rank = between(list[0], list[1]);
    }

    list.splice(1, 0, rank);
    assert.deepEqual(list, [...list].sort(), `order broke after ${insert + 1} inserts`);
    assert.ok(rank.length <= MAX_RANK_LENGTH, `${rank} exceeded the length limit`);
  }

  assert.equal(list.length, 1_002, "every insert landed");
  assert.ok(rebalances > 0, "the gap should have been exhausted at least once");
  assert.ok(rebalances < 100, `rebalanced ${rebalances} times, which is thrashing`);
});

test("moving an item around a list keeps the list sorted", () => {
  const random = seeded(777);

  // Ten items, then a few hundred random moves — the shape of someone dragging
  // cards around a backlog for an afternoon.
  let ranks: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    ranks.push(between(ranks.length === 0 ? null : ranks[ranks.length - 1], null));
  }

  for (let move = 0; move < 300; move += 1) {
    const from = Math.floor(random() * ranks.length);
    const to = Math.floor(random() * ranks.length);
    const rest = ranks.filter((_, index) => index !== from);
    const before = to === 0 ? null : rest[to - 1];
    const after = to >= rest.length ? null : rest[to];

    let moved: string;
    try {
      moved = between(before, after);
    } catch (error) {
      assert.ok(error instanceof RankSpaceExhausted);
      // A real caller rebalances here; the property under test is that it is
      // told to, rather than handed a rank that sorts in the wrong place.
      ranks = spread(ranks.length, null, null);
      continue;
    }

    rest.splice(to, 0, moved);
    ranks = rest;
    assert.deepEqual(ranks, [...ranks].sort(), `order broke on move ${move}`);
  }
});

test("a spread is evenly ordered and reproducible", () => {
  for (const count of [1, 2, 7, 64, 128]) {
    const ranks = spread(count, null, null);
    assert.equal(ranks.length, count);
    assert.deepEqual(ranks, [...ranks].sort(), `spread of ${count} was not ordered`);
    assert.equal(new Set(ranks).size, count, `spread of ${count} had duplicates`);

    // Same inputs, same outputs — this is what lets two clones rebalance the
    // same region independently and agree on the result.
    assert.deepEqual(spread(count, null, null), ranks);
    for (const rank of ranks) {
      assert.ok(isRank(rank), `${rank} left the alphabet`);
      assert.ok(rank.length <= MAX_RANK_LENGTH);
    }
  }
});

test("a spread stays inside the bounds it was given", () => {
  const random = seeded(31337);

  for (let trial = 0; trial < 200; trial += 1) {
    const low = between(null, null);
    const high = between(low, null);
    const count = 1 + Math.floor(random() * 32);

    const ranks = spread(count, low, high);
    assert.equal(ranks.length, count);
    for (const rank of ranks) {
      assert.ok(low < rank, `${rank} escaped below ${low}`);
      assert.ok(rank < high, `${rank} escaped above ${high}`);
    }
    assert.deepEqual(ranks, [...ranks].sort());
  }
});

test("exhaustion is reported rather than papered over", () => {
  // Adjacent in the string space with nothing between them.
  assert.throws(() => between("a", "a"), RankSpaceExhausted);
  assert.throws(() => between("b", "a"), RankSpaceExhausted);

  // A rank at the length limit cannot be split further.
  const long = "a".repeat(MAX_RANK_LENGTH);
  assert.throws(() => between(long, `${long}0`.slice(0, MAX_RANK_LENGTH)), RankSpaceExhausted);
});

test("the fixed parameters are the ones the decision names", () => {
  // S1-D13 calls these a storage-format decision: changing one changes what is
  // written to files, so it needs a schema_version bump and a migration. The
  // assertion is here so that reads as a deliberate act rather than a typo.
  assert.equal(ALPHABET, "0123456789abcdefghijklmnopqrstuvwxyz");
  assert.equal(INITIAL_RANK, "hzzzzz");
  assert.equal(MAX_RANK_LENGTH, 32);
  assert.equal(ALPHABET, ALPHABET.toLowerCase(), "mixed case would sort by locale");
});

/**
 * LJ-48. Appending is the ordinary case and must not consume the format.
 *
 * `between(before, null)` used to read "no upper bound" as all-`z` and bisect,
 * so each append landed halfway to the top and the rank grew two digits every
 * time: six at the first issue, thirty-two at the fourteenth. Past that the
 * caller reused the previous rank, so every issue from the fifteenth shared one
 * and `duplicateRankRegions` reported the region permanently. This board hit it
 * with 47 issues.
 */
test("a thousand appends stay distinct and stay short", () => {
  let rank = between(null, null);
  const seen = new Set([rank]);
  let longest = rank.length;

  for (let index = 1; index < 1_000; index += 1) {
    const next = between(rank, null);
    assert.ok(next > rank, `append ${index} must sort after its predecessor`);
    seen.add(next);
    longest = Math.max(longest, next.length);
    rank = next;
  }

  assert.equal(seen.size, 1_000, "every append is a distinct rank");
  // The old behaviour reached the limit at fourteen. Asserting the *initial*
  // width rather than merely "under the limit" is what makes this a test of
  // constant length rather than of slower growth.
  assert.equal(longest, INITIAL_RANK.length, "appending must not lengthen the rank");
});

test("appending does not crowd out inserting between", () => {
  const first = between(null, null);
  const second = between(first, null);

  // The step leaves room, so slotting something between two appended issues
  // does not have to lengthen anything.
  const middle = between(first, second);
  assert.ok(first < middle && middle < second);
  assert.equal(middle.length, INITIAL_RANK.length);
});

test("an appended rank keeps its trailing zeros", () => {
  // Trimming them would fold `i00000` to `i`, and the next append would read
  // that back, pad it to six and produce `i00000` a second time.
  let rank = between(null, null);
  const produced: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    rank = between(rank, null);
    produced.push(rank);
  }
  assert.equal(new Set(produced).size, produced.length);
  assert.ok(
    produced.every((value) => value.length === INITIAL_RANK.length),
    "every appended rank is rendered at full width",
  );
});

test("the space between two ranks still runs out, and says so", () => {
  // The append path must not have made exhaustion unreachable: the rebalance in
  // ADR-005 §3 is driven by this error, and a signal nothing raises is a
  // rebalance nothing triggers.
  let low = between(null, null);
  let high = between(low, null);
  assert.throws(() => {
    for (let index = 0; index < 200; index += 1) {
      high = between(low, high);
    }
  }, RankSpaceExhausted);
});
