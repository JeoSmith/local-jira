import type { Role } from "../domain/users.ts";

/**
 * What a role may do (PRD §6.4).
 *
 * Three fixed roles, no per-issue ACLs — the PRD deliberately keeps this
 * coarse. The split that matters is board content versus board operation:
 * everyone who can write may change issues, and only an admin may change who
 * the users are.
 */
export type Capability =
  | "issue:read"
  | "issue:write"
  | "issue:delete"
  | "issue:rank"
  | "claim:release"
  | "user:manage"
  | "token:manage";

const CAPABILITIES: Record<Role, Capability[]> = {
  admin: [
    "issue:read", "issue:write", "issue:delete", "issue:rank",
    "claim:release", "user:manage", "token:manage",
  ],
  // S1-D11: a member may delete anyone's issue. The event names who did it and
  // the file is in git, so the damage is visible and reversible; restricting it
  // to admin would block the common case of a one-person board.
  member: ["issue:read", "issue:write", "issue:delete", "issue:rank", "claim:release"],
  // An agent's session role grants nothing beyond reading. Its real permissions
  // come from the token's scopes (D9, enforced in r13b), so leaving write here
  // would be a second, weaker gate that quietly overrides the first.
  agent: ["issue:read"],
};

export class AuthorizationError extends Error {
  readonly code = "E_FORBIDDEN";
  readonly capability: Capability;
  readonly role: Role;

  constructor(role: Role, capability: Capability) {
    super(`Role "${role}" may not ${capability.replace(":", " ")}.`);
    this.name = "AuthorizationError";
    this.role = role;
    this.capability = capability;
  }
}

export function can(role: Role, capability: Capability): boolean {
  return CAPABILITIES[role]?.includes(capability) ?? false;
}

/** Throws rather than returning false, so a caller cannot forget to check. */
export function require(role: Role, capability: Capability): void {
  if (!can(role, capability)) {
    throw new AuthorizationError(role, capability);
  }
}

export function capabilitiesOf(role: Role): Capability[] {
  return [...(CAPABILITIES[role] ?? [])];
}
