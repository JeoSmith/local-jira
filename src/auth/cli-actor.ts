/**
 * Who a CLI command is acting as.
 *
 * Until r13c the CLI wrote every issue as `{ id: "local", kind: "human" }` with
 * a comment saying there was no session yet, so a file would never claim an
 * agent had written it. That was right when it was written and wrong the moment
 * PATs landed: an agent reaches for the CLI first — it is shorter and needs no
 * header — and every issue it created was recorded as a person's work. §8 says
 * an agent's change must never read as a human's, and the badge that carries
 * that promise was quietly lying on the one path nobody had rechecked.
 *
 * So the CLI resolves an actor the same way the server does, from the same
 * store, and a write with no actor is refused rather than attributed to an
 * invented one. A fabricated record is worse than a failed command.
 */

import process from "node:process";

import { CredentialStore, type TokenRecord } from "./credentials.ts";
import { TOKEN_SCOPES, type TokenScope } from "./authorize.ts";
import { listUsers, type Role } from "../domain/users.ts";
import type { BoardHandle } from "../storage/board.ts";
import type { Actor } from "../domain/issue.ts";

/** The environment variable, so a token never has to appear in a command line. */
export const TOKEN_ENV = "LOCALJIRA_TOKEN";

export type CliAuthReason =
  | "missing"
  | "unknown"
  | "revoked"
  | "expired"
  | "no_such_user"
  | "out_of_scope";

export class CliAuthError extends Error {
  readonly code: string;
  readonly reason: CliAuthReason;
  readonly hint: string | null;

  constructor(reason: CliAuthReason, message: string, hint: string | null = null) {
    super(message);
    this.name = "CliAuthError";
    this.reason = reason;
    this.hint = hint;
    this.code = CODES[reason];
  }
}

const CODES: Record<CliAuthReason, string> = {
  missing: "E_TOKEN_REQUIRED",
  unknown: "E_TOKEN_INVALID",
  revoked: "E_TOKEN_REVOKED",
  expired: "E_TOKEN_EXPIRED",
  no_such_user: "E_TOKEN_ORPHANED",
  out_of_scope: "E_FORBIDDEN",
};

export interface CliActor {
  actor: Actor & { tokenId: string };
  role: Role;
  record: TokenRecord;
}

/** `--token` beats the environment, so one command can override a shell default. */
export function presentedToken(fromFlag: string | undefined): string | null {
  const value = fromFlag ?? process.env[TOKEN_ENV];
  return value === undefined || value.trim() === "" ? null : value.trim();
}

/**
 * Resolves the presented token into an actor, or explains why it cannot.
 *
 * The four refusal reasons are kept apart because they need different things
 * from the person reading them: a revoked token means somebody killed it on
 * purpose, an expired one means reissue, an unknown one means the value is
 * wrong, and an orphaned one means the account left `users.yaml` — which is
 * exactly how removing a line from that file ends access everywhere at once.
 */
export function resolveCliActor(
  board: BoardHandle,
  options: { token: string | null; scope: TokenScope },
): CliActor {
  if (options.token === null) {
    throw new CliAuthError(
      "missing",
      "This command writes to the board, so it needs to say who is writing.",
      `Set ${TOKEN_ENV}, or pass --token. Create one with: localjira token create ` +
        "--user <ID> --password <PW>",
    );
  }

  const store = new CredentialStore(board.localDirectory);
  try {
    const found = store.resolveToken(options.token);
    if (!found.ok) {
      throw new CliAuthError(found.reason, REFUSALS[found.reason], HINTS[found.reason]);
    }

    const user = listUsers(board).find((entry) => entry.id === found.record.userId);
    if (!user) {
      throw new CliAuthError(
        "no_such_user",
        `The token belongs to ${found.record.userId}, who is not in users.yaml.`,
        "Add the account back, or issue a token for one that exists.",
      );
    }

    if (!found.record.scopes.includes(options.scope)) {
      // Before the write, and without touching the file. A command that is
      // going to be refused must not leave half its effect behind.
      throw new CliAuthError(
        "out_of_scope",
        `This token does not have ${options.scope}.`,
        `It has: ${found.record.scopes.join(", ") || "(none)"}`,
      );
    }

    // Only once the token is known good. Touching on a failed attempt would make
    // `last_used_at` say a dead token is in use.
    store.touchToken(found.record.tokenId);

    return {
      // The same mapping the server uses (`actorOf`): role decides the kind, so
      // the two paths cannot disagree about what an agent's file looks like.
      actor: {
        id: user.id,
        kind: user.role === "agent" ? "agent" : "human",
        tokenId: found.record.tokenId,
      },
      role: user.role,
      record: found.record,
    };
  } finally {
    store.close();
  }
}

const REFUSALS: Record<"unknown" | "revoked" | "expired", string> = {
  unknown: "That token is not one this board issued.",
  revoked: "That token was revoked.",
  expired: "That token has expired.",
};

const HINTS: Record<"unknown" | "revoked" | "expired", string> = {
  unknown: `Check ${TOKEN_ENV}, or issue a new token.`,
  revoked: "Issue a new one; revocation takes effect immediately and is not reversible.",
  expired: "Issue a new one with: localjira token create --user <ID> --password <PW>",
};

export function isKnownScope(value: string): value is TokenScope {
  return (TOKEN_SCOPES as readonly string[]).includes(value);
}
