/**
 * Deterministic display-key rekeying (D3, 설계 §3.8).
 *
 * Two clones that each created `LJ-13` offline and then merged must both decide
 * the same way about who keeps it — with no server between them to arbitrate.
 * So every input to the decision is drawn from the merged file set itself, and
 * nothing here consults a counter, a clock, or the order rows came back in.
 */

import { isUlid } from "../bootstrap/identifier.ts";

export { isUlid };

export interface Claimant {
  uid: string;
  key: string;
  path: string;
}

export interface Rekey {
  uid: string;
  path: string;
  from: string;
  to: string;
}

/**
 * Orders the claimants to one key, winner first.
 *
 * ULID timestamp ascending, then the whole string. The timestamp is what makes
 * "whoever created it first keeps it" true at millisecond resolution; the
 * string comparison is what keeps the answer identical on both clones when two
 * ULIDs share a millisecond, because the remaining bits are random and their
 * lexicographic order says nothing about which came first. Determinism survives
 * either way — being *the same* everywhere matters more here than being right
 * about a sub-millisecond ordering nobody can observe.
 */
function byCreation(a: Claimant, b: Claimant): number {
  const left = a.uid.slice(0, 10);
  const right = b.uid.slice(0, 10);
  if (left !== right) {
    return left < right ? -1 : 1;
  }
  return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}

/** The numeric half of `LJ-13`, or null when the key is not of that shape. */
export function keyNumber(key: string): number | null {
  const match = /-(\d+)$/.exec(key);
  return match ? Number(match[1]) : null;
}

export interface RekeyPlanInput {
  project: string;
  /** Every issue in the project, from the reconcile's own scan. */
  claimants: Claimant[];
}

/**
 * Plans every rekey for a project in one pass.
 *
 * All collisions are resolved together against a snapshot of the highest key
 * number, and the losers are numbered in a globally sorted order. Doing groups
 * one at a time was the v1 defect: with `LJ-13` and `LJ-14` both colliding, the
 * assignment depended on which group was noticed first, and two clones that
 * scanned in different orders disagreed.
 *
 * Idempotent by construction — run it on its own output and there are no
 * collisions left to resolve, so it plans nothing.
 */
export function planRekeys(input: RekeyPlanInput): Rekey[] {
  const groups = new Map<string, Claimant[]>();
  let highest = 0;

  for (const claimant of input.claimants) {
    const number = keyNumber(claimant.key);
    if (number !== null && number > highest) {
      highest = number;
    }
    const group = groups.get(claimant.key);
    if (group) {
      group.push(claimant);
    } else {
      groups.set(claimant.key, [claimant]);
    }
  }

  // Losers from every group first, then numbered together. The sort key is the
  // original key number and then the uid, both of which every clone can see.
  const losers: Claimant[] = [];
  for (const [, group] of groups) {
    if (group.length < 2) {
      continue;
    }
    // A uid that is not a ULID cannot be ordered by creation, and guessing
    // would break the one property this exists to provide. §3.6 quarantines
    // those instead, so they are left alone here.
    if (group.some((claimant) => !isUlid(claimant.uid))) {
      continue;
    }
    const ordered = [...group].sort(byCreation);
    losers.push(...ordered.slice(1));
  }

  losers.sort((a, b) => {
    const left = keyNumber(a.key) ?? Number.MAX_SAFE_INTEGER;
    const right = keyNumber(b.key) ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) {
      return left - right;
    }
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  });

  return losers.map((loser, index) => ({
    uid: loser.uid,
    path: loser.path,
    from: loser.key,
    to: `${input.project}-${highest + index + 1}`,
  }));
}
