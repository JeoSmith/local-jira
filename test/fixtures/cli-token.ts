/**
 * A token for suites that use `localjira issue create` to make an issue exist.
 *
 * r13c made writes require one, because the CLI used to record every caller as
 * `{ id: "local", kind: "human" }` and an agent using it — the shorter path, the
 * one it reaches for first — had its work filed as a person's. The cost is
 * exactly this: every existing caller now needs an account and a token. That
 * cost is the point. The board records who wrote, and there is no honest answer
 * when nobody said.
 *
 * These suites are not about authentication (`test/auth/cli-token.test.ts` is),
 * so the token is minted on demand and injected rather than threaded through
 * every call site.
 */

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

export const FIXTURE_USER = "fixture";
export const FIXTURE_PASSWORD = "fixture password here";

/** One token per board, so a suite does not mint one per call. */
const cache = new Map<string, string>();

function raw(repo: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/**
 * A token that may write issues.
 *
 * `member`, not `agent`: these fixtures stand in for a person at a terminal, and
 * an `agent` token would quietly change `created_by_kind` in every suite that
 * reads it.
 */
export function cliWriteToken(repo: string): string {
  const known = cache.get(repo);
  if (known !== undefined) {
    return known;
  }

  const account = raw(repo, [
    "admin", "create",
    "--id", FIXTURE_USER, "--name", "픽스처", "--password", FIXTURE_PASSWORD,
    "--role", "member",
  ]);
  // A suite that bootstrapped its own admin first will have made this one a
  // member; one that did not will have made it the admin. Either can write.
  assert.ok(account.status === 0, account.stderr);

  const issued = raw(repo, [
    "token", "create",
    "--user", FIXTURE_USER, "--password", FIXTURE_PASSWORD,
    "--scope", "issue:read", "--scope", "issue:edit",
  ]);
  assert.equal(issued.status, 0, issued.stderr);

  const token = issued.stdout.trim();
  cache.set(repo, token);
  return token;
}

/** True for the commands that write domain files and so need an actor. */
function needsActor(args: string[]): boolean {
  return args[0] === "issue" && args[1] === "create";
}

/**
 * Runs the CLI, supplying a token when the command writes.
 *
 * An explicit `LOCALJIRA_TOKEN` in `env` always wins, so a test can still
 * exercise a missing or wrong token by passing one.
 */
export function runCli(
  repo: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  const supplied = "LOCALJIRA_TOKEN" in env ? {} : injected(repo, args);
  return raw(repo, args, { ...supplied, ...env });
}

function injected(repo: string, args: string[]): NodeJS.ProcessEnv {
  return needsActor(args) ? { LOCALJIRA_TOKEN: cliWriteToken(repo) } : {};
}
