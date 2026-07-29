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
  | "index:rebuild"
  | "index:verify"
  | "sprint:write"
  | "claim:release"
  | "user:manage"
  | "token:manage";

const CAPABILITIES: Record<Role, Capability[]> = {
  admin: [
    "issue:read", "issue:write", "issue:delete", "issue:rank",
    "claim:release", "user:manage", "token:manage",
    "index:rebuild", "index:verify", "sprint:write",
  ],
  // S1-D11: a member may delete anyone's issue. The event names who did it and
  // the file is in git, so the damage is visible and reversible; restricting it
  // to admin would block the common case of a one-person board.
  // Verify only reads and reports; a rebuild swaps the index generation and
  // pauses writes while it does, which is an operational act (설계 §3.7).
  member: [
    "issue:read", "issue:write", "issue:delete", "issue:rank", "claim:release",
    "index:verify",
    // Held here, but only for their own account — `canManageTokensFor` is what
    // draws that line, because a capability list cannot express "for whom".
    "token:manage",
    // Its own capability rather than folded into issue:write. Shaping the
    // sprints is planning, not content, and an agent that may one day edit
    // issues must not thereby be able to restructure what the team commits to.
    "sprint:write",
  ],
  // An agent's session role grants nothing beyond reading. Its real permissions
  // come from the token's scopes (D9, enforced in r13b), so leaving write here
  // would be a second, weaker gate that quietly overrides the first.
  agent: ["issue:read"],
};

/**
 * The scopes a PAT may carry (PRD §6.4).
 *
 * Fixed at seven. These are the *token's* axis of permission, separate from
 * the role's capabilities above: a token can never exceed its user's role, and
 * within that it does only what its scopes name. r13b enforces them; r13a
 * stores them and rejects anything not on this list.
 */
export const TOKEN_SCOPES = [
  "issue:read",
  "issue:comment",
  "issue:transition",
  "issue:edit",
  "issue:rank",
  "run:write",
  "issue:delete",
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/**
 * What an agent token gets when the issuer does not choose (D9).
 *
 * `issue:rank` and `issue:delete` are absent on purpose — reordering the
 * backlog and destroying work are people's decisions, and a token gets them
 * only when somebody names them explicitly.
 */
export const DEFAULT_AGENT_SCOPES: TokenScope[] = [
  "issue:read",
  "issue:comment",
  "issue:transition",
  "run:write",
];

export function isTokenScope(value: string): value is TokenScope {
  return (TOKEN_SCOPES as readonly string[]).includes(value);
}

/**
 * Whether `actor` may issue or revoke tokens belonging to `subject` (S3-D8).
 *
 * Split by target rather than granted wholesale. Admin-only issuance pushes
 * teams into sharing the admin account; letting a member issue for anybody
 * lets them produce audit entries under someone else's name, which contradicts
 * the promise that who changed a thing is always distinguishable (PRD §1).
 */
export function canManageTokensFor(actor: { id: string; role: Role }, subjectId: string): boolean {
  if (actor.role === "admin") {
    return true;
  }
  return actor.role === "member" && actor.id === subjectId;
}

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
