import assert from "node:assert/strict";
import test from "node:test";

import { createUlid } from "../../src/bootstrap/identifier.ts";
import { isUlid, keyNumber, planRekeys, type Claimant } from "../../src/domain/rekey.ts";

/**
 * Rekeying has one property that matters more than any example: two clones
 * that merged the same files must reach the same answer with nothing between
 * them to arbitrate. That is a claim about *every* input, so it is tested as
 * one — thousands of generated collisions rather than a handful of chosen ones.
 *
 * The generator is a seeded xorshift written out here, as in rank.test.ts: the
 * project has no dependencies, and a fixed seed means a failure reproduces
 * exactly instead of appearing once on CI and never again.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID whose timestamp half is `at`, so creation order is controllable. */
function ulid(at: number, random: () => number): string {
  let timestamp = "";
  let remaining = at;
  for (let index = 0; index < 10; index += 1) {
    timestamp = CROCKFORD[remaining % 32] + timestamp;
    remaining = Math.floor(remaining / 32);
  }
  let tail = "";
  for (let index = 0; index < 16; index += 1) {
    tail += CROCKFORD[Math.floor(random() * 32)];
  }
  return timestamp + tail;
}

function claimants(random: () => number, count: number, keyPool: number): Claimant[] {
  const out: Claimant[] = [];
  for (let index = 0; index < count; index += 1) {
    const number = 1 + Math.floor(random() * keyPool);
    const key = `LJ-${number}`;
    out.push({
      uid: ulid(Math.floor(random() * 4_000), random),
      key,
      path: `issues/LJ/${key}.md#${index}`,
    });
  }
  return out;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

test("the plan does not depend on the order the files were scanned in", () => {
  const random = seeded(20260729);

  for (let trial = 0; trial < 500; trial += 1) {
    const input = claimants(random, 2 + Math.floor(random() * 25), 6);
    const first = planRekeys({ project: "LJ", claimants: input });
    const second = planRekeys({ project: "LJ", claimants: shuffle(input, random) });

    // This is the whole point: two clones scan the same merged tree in whatever
    // order their filesystem hands it over, and must still agree.
    assert.deepEqual(
      [...second].sort((a, b) => a.uid.localeCompare(b.uid)),
      [...first].sort((a, b) => a.uid.localeCompare(b.uid)),
      `trial ${trial} diverged on scan order`,
    );
  }
});

test("no key is handed out twice, and no survivor loses its key", () => {
  const random = seeded(4242);

  for (let trial = 0; trial < 500; trial += 1) {
    const input = claimants(random, 2 + Math.floor(random() * 30), 5);
    const plan = planRekeys({ project: "LJ", claimants: input });

    const assigned = plan.map((entry) => entry.to);
    assert.equal(new Set(assigned).size, assigned.length, "a new key was issued twice");

    // The keys that stay put must not collide with the ones being issued.
    const moved = new Set(plan.map((entry) => entry.uid));
    const kept = input.filter((entry) => !moved.has(entry.uid)).map((entry) => entry.key);
    for (const key of assigned) {
      assert.equal(kept.includes(key), false, `${key} was issued to a loser and also kept`);
    }
  }
});

test("applying the plan leaves nothing to do", () => {
  const random = seeded(31337);

  for (let trial = 0; trial < 300; trial += 1) {
    const input = claimants(random, 2 + Math.floor(random() * 20), 4);
    const plan = planRekeys({ project: "LJ", claimants: input });

    const moved = new Map(plan.map((entry) => [entry.uid, entry.to]));
    const applied = input.map((entry) => ({ ...entry, key: moved.get(entry.uid) ?? entry.key }));

    // Idempotence is what makes a crash mid-rekey safe: the next reconcile
    // recomputes from the files and must not push the keys along again.
    assert.deepEqual(
      planRekeys({ project: "LJ", claimants: applied }),
      [],
      `trial ${trial} still had work after applying its own plan`,
    );
  }
});

test("the earliest ULID keeps the key", () => {
  const random = seeded(7);

  for (let trial = 0; trial < 200; trial += 1) {
    const at = 1_000 + Math.floor(random() * 1_000);
    const group: Claimant[] = [
      { uid: ulid(at, random), key: "LJ-13", path: "a.md" },
      { uid: ulid(at + 1 + Math.floor(random() * 50), random), key: "LJ-13", path: "b.md" },
      { uid: ulid(at + 60 + Math.floor(random() * 50), random), key: "LJ-13", path: "c.md" },
    ];

    const plan = planRekeys({ project: "LJ", claimants: shuffle(group, random) });
    assert.equal(plan.length, 2, "two of three should move");
    assert.equal(
      plan.some((entry) => entry.uid === group[0].uid),
      false,
      "the earliest ULID must keep LJ-13",
    );
  }
});

test("simultaneous collisions on different keys are numbered together", () => {
  // The v1 defect: resolving one group at a time made the outcome depend on
  // which group was noticed first. Both groups are planned against one snapshot.
  const random = seeded(99);
  const input: Claimant[] = [
    { uid: ulid(100, random), key: "LJ-13", path: "a.md" },
    { uid: ulid(200, random), key: "LJ-13", path: "b.md" },
    { uid: ulid(150, random), key: "LJ-14", path: "c.md" },
    { uid: ulid(250, random), key: "LJ-14", path: "d.md" },
  ];

  const plan = planRekeys({ project: "LJ", claimants: input });
  assert.deepEqual(
    plan.map((entry) => `${entry.from}→${entry.to}`),
    ["LJ-13→LJ-15", "LJ-14→LJ-16"],
    "losers are numbered by original key, then uid, from one snapshot",
  );

  // …and the reverse scan order produces exactly the same assignment.
  assert.deepEqual(planRekeys({ project: "LJ", claimants: [...input].reverse() }), plan);
});

test("a uid that is not a ULID is left for quarantine, not rekeyed", () => {
  const random = seeded(11);
  const plan = planRekeys({
    project: "LJ",
    claimants: [
      { uid: ulid(100, random), key: "LJ-13", path: "a.md" },
      { uid: "handwritten-uid", key: "LJ-13", path: "b.md" },
    ],
  });

  // Creation order is unknowable here, and guessing would break the one
  // property this module exists to provide. §3.6 quarantines these instead.
  assert.deepEqual(plan, []);
});

test("a key with no collision is never touched", () => {
  const random = seeded(5);
  const plan = planRekeys({
    project: "LJ",
    claimants: [
      { uid: ulid(100, random), key: "LJ-1", path: "a.md" },
      { uid: ulid(200, random), key: "LJ-2", path: "b.md" },
      { uid: ulid(300, random), key: "LJ-3", path: "c.md" },
    ],
  });
  assert.deepEqual(plan, []);
});

test("the helpers agree with the shapes they are given", () => {
  assert.equal(keyNumber("LJ-13"), 13);
  assert.equal(keyNumber("LJ-S3"), null, "a sprint id is not an issue key");
  // Round-tripped through the real generator rather than hand-typed: the last
  // hand-typed fixture contained a `U`, which Crockford base32 does not have,
  // and it looked like a ULID to everyone except the checker.
  assert.equal(isUlid(createUlid()), true);
  assert.equal(isUlid("handwritten"), false);
  assert.equal(isUlid("01JBULK0000000000000000000"), false, "U is not in Crockford base32");
});
