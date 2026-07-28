/**
 * The status transition table (PRD §5.2).
 *
 * The table is data, not scattered `if`s, because it is the one place the
 * board's rules about "what can follow what" are stated. Anything not listed
 * is refused — an allow-list, so a new status cannot silently become reachable
 * from everywhere.
 */
export const STATUSES = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "DONE",
  "BLOCKED",
  "CANCELLED",
] as const;
export type Status = (typeof STATUSES)[number];

/** Transitions any role may make, given the source status. */
const ALLOWED: Record<Status, Status[]> = {
  BACKLOG: ["TODO", "BLOCKED", "CANCELLED"],
  TODO: ["BACKLOG", "IN_PROGRESS", "BLOCKED", "CANCELLED"],
  IN_PROGRESS: ["TODO", "IN_REVIEW", "BLOCKED", "CANCELLED"],
  IN_REVIEW: ["IN_PROGRESS", "DONE", "BLOCKED", "CANCELLED"],
  // Reopening is the only way out of DONE; going straight back to TODO would
  // lose the fact that the work had been completed once.
  DONE: ["IN_PROGRESS"],
  // BLOCKED returns only to where it came from — see resolveTargets.
  BLOCKED: ["CANCELLED"],
  // CANCELLED is terminal for everyone but an admin.
  CANCELLED: ["BACKLOG"],
};

/** Transitions that need the admin role (PRD §5.2). */
const ADMIN_ONLY: Array<{ from: Status; to: Status }> = [
  { from: "CANCELLED", to: "BACKLOG" },
];

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

/**
 * The statuses reachable from here.
 *
 * `BLOCKED` is special: it returns to whatever it interrupted, so the source
 * of truth is the issue's own `blocked_from` rather than a fixed row. Fixing
 * a row would either forget where the work was or let it resume anywhere.
 */
export function allowedTargets(from: Status, blockedFrom: string | null): Status[] {
  if (from !== "BLOCKED") {
    return ALLOWED[from];
  }
  const back = blockedFrom && isStatus(blockedFrom) ? [blockedFrom] : [];
  return [...back, ...ALLOWED.BLOCKED];
}

export function requiresAdmin(from: Status, to: Status): boolean {
  return ADMIN_ONLY.some((rule) => rule.from === from && rule.to === to);
}

/** True when entering `to` should record where the issue came from. */
export function shouldRecordBlockedFrom(to: Status): boolean {
  return to === "BLOCKED";
}
