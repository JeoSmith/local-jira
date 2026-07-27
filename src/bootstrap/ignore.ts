import fs from "node:fs";

export const CODE_IGNORE_RULE = "/.localjira/";
export const DATA_IGNORE_RULE = "/.local/";

export interface IgnoreRuleStatus {
  /** An equivalent rule is in force (a later negation cancels an earlier match). */
  covered: boolean;
  /** The last equivalent line, negated or not. */
  matchedLine: string | null;
  negatedLine: string | null;
  fileExists: boolean;
}

export interface EnsureIgnoreResult {
  changed: boolean;
  createdFile: boolean;
  appendedLine: string | null;
  status: IgnoreRuleStatus;
}

/**
 * Reports whether a `.gitignore` already ignores the given root-anchored path.
 *
 * Git applies the *last* matching pattern, so a trailing `!/.localjira/`
 * un-ignores the directory no matter how many positive rules precede it.
 * Treating any textual match as "already configured" would make bootstrap skip
 * the rule while the board stays visible to the code branch.
 */
export function inspectIgnoreRule(
  file: string,
  rule: string,
): IgnoreRuleStatus {
  if (!fs.existsSync(file)) {
    return { covered: false, matchedLine: null, negatedLine: null, fileExists: false };
  }

  const wanted = normalizeIgnoreRule(rule);
  let matchedLine: string | null = null;
  let negatedLine: string | null = null;
  let covered = false;

  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const negated = line.startsWith("!");
    const candidate = normalizeIgnoreRule(negated ? line.slice(1) : line);
    if (candidate !== wanted) {
      continue;
    }

    matchedLine = line;
    if (negated) {
      negatedLine = line;
      covered = false;
    } else {
      covered = true;
    }
  }

  return { covered, matchedLine, negatedLine, fileExists: fs.existsSync(file) };
}

/**
 * Appends the rule unless an equivalent one is already in force.
 *
 * The existing line ending is reused so a CRLF file does not gain a stray LF,
 * and the file is never rewritten wholesale — only appended to.
 */
export function ensureIgnoreRule(
  file: string,
  rule: string,
): EnsureIgnoreResult {
  const status = inspectIgnoreRule(file, rule);
  if (status.covered) {
    return { changed: false, createdFile: false, appendedLine: null, status };
  }

  const createdFile = !status.fileExists;
  const existing = createdFile ? "" : fs.readFileSync(file, "utf8");
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const separator =
    existing === "" || existing.endsWith("\n") || existing.endsWith("\r\n")
      ? ""
      : newline;

  fs.writeFileSync(file, `${existing}${separator}${rule}${newline}`, "utf8");

  return {
    changed: true,
    createdFile,
    appendedLine: rule,
    status: inspectIgnoreRule(file, rule),
  };
}

/**
 * Collapses the spellings that select the same path at the repository root:
 * `/.local/`, `/.local`, `.local/` and `.local`.
 *
 * A rule without a leading slash matches at every depth, so it is broader than
 * the anchored form rather than identical — but it does cover the root path,
 * which is all bootstrap needs, and appending a second rule would be noise.
 */
function normalizeIgnoreRule(rule: string): string {
  return rule.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}
