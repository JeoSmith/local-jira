/**
 * One process racing for one claim.
 *
 * A separate process because a read-then-write implementation cannot lose a
 * race inside a single thread: node:sqlite is synchronous, so nothing else runs
 * between the read and the write. Two processes can interleave there, which is
 * what makes this able to tell the two designs apart (r16a AC2).
 *
 * Usage: claim-race.ts <localDirectory> <issueUid> <ownerId> <runId> <startAtMs>
 */
import process from "node:process";

import { RuntimeStore } from "../../src/storage/runtime.ts";

const [local, issueUid, ownerId, runId, startAt] = process.argv.slice(2);
const store = new RuntimeStore(local);

// Both processes are open and warm before either touches the table, so the
// window they contend in is as small as the machine allows.
while (Date.now() < Number(startAt)) {
  // spin
}

const result = store.acquire(issueUid, ownerId, runId);
store.close();
process.stdout.write(`${result.outcome}\n`);
