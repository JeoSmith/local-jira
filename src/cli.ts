#!/usr/bin/env node

import process from "node:process";

import {
  runInit,
  runRepairWorktree,
  type CommandResult,
} from "./bootstrap/commands.ts";
import { inspectBootstrap } from "./bootstrap/doctor.ts";
import { BootstrapError } from "./bootstrap/execute.ts";
import { BootstrapInputError, validateProjectInput } from "./bootstrap/input.ts";
import {
  BootstrapBusyError,
  BootstrapLockUnsupportedError,
} from "./bootstrap/lock.ts";
import { createIssue, IssueError } from "./domain/issue.ts";
import {
  bootstrapAdmin,
  createUser,
  listUsers,
  needsBootstrap,
  UserError,
  type Role,
} from "./domain/users.ts";
import { PasswordError } from "./auth/password.ts";
import { startServer } from "./server/http.ts";
import {
  findIssue,
  indexStatus,
  listIssues,
  openBoard,
  openBoardForWriting,
  type IndexStatus,
  type IssueDetail,
  type IssueSummary,
} from "./storage/board.ts";
import { reconcileFull } from "./storage/external.ts";

const USAGE = `Usage:
  localjira doctor [--json]
  localjira init --project-key <KEY> --project-name <NAME> --timezone <TZ>
                 [--remote <NAME>] [--push] [--json]
  localjira repair-worktree [--remote <NAME>] [--json]

  localjira index status|rebuild|reconcile [--json]
  localjira index rebuild [--json]
  localjira issue list [--project <KEY>] [--status <STATUS>] [--limit <N>] [--json]
  localjira issue show <KEY> [--json]
  localjira issue create --project <KEY> --type <TYPE> --title <TITLE>
                 [--description <TEXT>] [--points <N>] [--assignee <ID>]
                 [--label <NAME>]... [--acceptance <TEXT>]... [--json]

  localjira admin create --id <ID> --name <NAME> --password <PW> [--role <ROLE>] [--json]
  localjira user list [--json]
  localjira serve [--port <N>] [--host <ADDR>]
`;

const [command, ...argv] = process.argv.slice(2);

try {
  switch (command) {
    case "doctor":
      runDoctor(argv);
      break;
    case "init":
      await runInitCommand(argv);
      break;
    case "repair-worktree":
      await runRepairCommand(argv);
      break;
    case "index":
      await runIndexCommand(argv);
      break;
    case "issue":
      await runIssueCommand(argv);
      break;
    case "admin":
      runAdminCommand(argv);
      break;
    case "user":
      runUserCommand(argv);
      break;
    case "serve":
      await runServeCommand(argv);
      break;
    default:
      process.stderr.write(USAGE);
      process.exitCode = 2;
  }
} catch (error) {
  reportFailure(error, argv.includes("--json"));
}

function runDoctor(args: string[]): void {
  const options = parseArgs(args, new Set(), new Set(["--json"]));
  const report = inspectBootstrap(process.cwd());

  if (options.flags.has("--json")) {
    write(JSON.stringify(report, null, 2));
  } else {
    printDoctorReport(report);
  }

  process.exitCode = report.ok || report.status === "UNINITIALIZED" ? 0 : 1;
}

async function runInitCommand(args: string[]): Promise<void> {
  const options = parseArgs(
    args,
    new Set(["--project-key", "--project-name", "--timezone", "--remote"]),
    new Set(["--push", "--json"]),
  );

  const missing = ["--project-key", "--project-name", "--timezone"].filter(
    (name) => !options.values.has(name),
  );
  if (missing.length > 0) {
    process.stderr.write(`Missing required arguments: ${missing.join(", ")}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const project = validateProjectInput({
    projectKey: options.values.get("--project-key") ?? "",
    projectName: options.values.get("--project-name") ?? "",
    timezone: options.values.get("--timezone") ?? "",
  });

  const result = await runInit({
    cwd: process.cwd(),
    project,
    remote: options.values.get("--remote"),
    push: options.flags.has("--push"),
  });

  report(result, options.flags.has("--json"));
}

async function runRepairCommand(args: string[]): Promise<void> {
  const options = parseArgs(
    args,
    new Set(["--remote"]),
    new Set(["--json"]),
  );

  const result = await runRepairWorktree({
    cwd: process.cwd(),
    remote: options.values.get("--remote"),
  });

  report(result, options.flags.has("--json"));
}

async function runIndexCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "reconcile") {
    return runReconcileCommand(rest);
  }
  if (sub !== "status" && sub !== "rebuild") {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  const options = parseArgs(rest, new Set(), new Set(["--json"]));
  const board = openBoard(process.cwd(), { rebuild: sub === "rebuild" });
  try {
    const status = indexStatus(board);
    if (options.flags.has("--json")) {
      write(JSON.stringify(status, null, 2));
    } else {
      printIndexStatus(status);
    }
    process.exitCode = status.errors.length > 0 ? 1 : 0;
  } finally {
    board.close();
  }
}

/**
 * Reconciles the whole board on demand.
 *
 * The safety net under the watcher: after a pull on a machine whose watcher was
 * not running, or when someone simply wants to be sure, this is the same full
 * pass the server runs on startup — reason `manual` so the log says who asked.
 */
async function runReconcileCommand(args: string[]): Promise<void> {
  const options = parseArgs(args, new Set(), new Set(["--json"]));
  const writable = await openBoardForWriting(process.cwd());

  try {
    const { report } = await reconcileFull(writable, "manual");
    if (options.flags.has("--json")) {
      write(JSON.stringify(report, null, 2));
      return;
    }
    write(
      `reconciled (${report.reason})\n` +
        `  scanned    ${report.scanned} file(s), hashed ${report.hashed}\n` +
        `  changed    ${report.changed.length}\n` +
        `  moved      ${report.renamed.length}\n` +
        `  tombstoned ${report.tombstoned.length}\n` +
        `  deleted    ${report.confirmed.length}\n` +
        `  took       ${report.durationMs}ms`,
    );
    for (const gone of report.tombstoned) {
      write(`  - ${gone.key ?? gone.uid} disappeared (${gone.path})`);
    }
    for (const moved of report.renamed) {
      write(`  - ${moved.key ?? moved.uid} moved ${moved.from} -> ${moved.to}`);
    }
  } finally {
    await writable.close();
  }
}

async function runIssueCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  if (sub === "list") {
    const options = parseArgs(
      rest,
      new Set(["--project", "--status", "--limit"]),
      new Set(["--json"]),
    );
    const board = openBoard(process.cwd());
    try {
      const issues = listIssues(board, {
        project: options.values.get("--project"),
        status: options.values.get("--status"),
        limit: options.values.has("--limit")
          ? Number(options.values.get("--limit"))
          : undefined,
      });
      if (options.flags.has("--json")) {
        write(JSON.stringify(issues, null, 2));
      } else {
        printIssueTable(issues);
      }
    } finally {
      board.close();
    }
    return;
  }

  if (sub === "create") {
    const options = parseArgs(
      rest,
      new Set([
        "--project", "--type", "--title", "--description",
        "--points", "--assignee", "--label", "--acceptance",
      ]),
      new Set(["--json"]),
    );

    const missing = ["--project", "--type", "--title"].filter(
      (name) => !options.values.has(name),
    );
    if (missing.length > 0) {
      process.stderr.write(`Missing required arguments: ${missing.join(", ")}\n${USAGE}`);
      process.exitCode = 2;
      return;
    }

    const writable = await openBoardForWriting(process.cwd());
    try {
      const issue = await createIssue(
        writable,
        {
          project: options.values.get("--project") ?? "",
          type: options.values.get("--type") ?? "",
          title: options.values.get("--title") ?? "",
          description: options.values.get("--description"),
          points: options.values.has("--points")
            ? Number(options.values.get("--points"))
            : null,
          assignee: options.values.get("--assignee") ?? null,
          labels: options.repeated.get("--label") ?? [],
          acceptance: (options.repeated.get("--acceptance") ?? []).map((text) => ({ text })),
        },
        // Until r12a lands there is no session; the actor is recorded as the
        // local human so the file never claims an agent wrote it.
        { id: "local", kind: "human" },
      );

      if (options.flags.has("--json")) {
        write(JSON.stringify(issue, null, 2));
      } else {
        write(`Created ${issue.key}`);
        write("");
        printIssueDetail(issue);
      }
    } finally {
      await writable.close();
    }
    return;
  }

  if (sub === "show") {
    const [key, ...flags] = rest;
    if (!key || key.startsWith("--")) {
      process.stderr.write(`issue show requires an issue key\n${USAGE}`);
      process.exitCode = 2;
      return;
    }

    const options = parseArgs(flags, new Set(), new Set(["--json"]));
    const board = openBoard(process.cwd());
    try {
      const found = findIssue(board, key);
      if (found === null) {
        process.stderr.write(`E_ISSUE_NOT_FOUND: no issue with key ${key}\n`);
        process.exitCode = 1;
        return;
      }
      if ("ambiguous" in found) {
        // Choosing one would attach the wrong history to the wrong issue.
        process.stderr.write(
          `E_KEY_AMBIGUOUS: ${key} matches ${found.ambiguous.length} issues: ${found.ambiguous.join(", ")}\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (options.flags.has("--json")) {
        write(JSON.stringify(found.issue, null, 2));
      } else {
        printIssueDetail(found.issue);
      }
    } finally {
      board.close();
    }
    return;
  }

  process.stderr.write(USAGE);
  process.exitCode = 2;
}

function runAdminCommand(args: string[]): void {
  const [sub, ...rest] = args;
  if (sub !== "create") {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  const options = parseArgs(
    rest,
    new Set(["--id", "--name", "--password", "--role"]),
    new Set(["--json"]),
  );
  const missing = ["--id", "--name", "--password"].filter((name) => !options.values.has(name));
  if (missing.length > 0) {
    process.stderr.write(`Missing required arguments: ${missing.join(", ")}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const board = openBoard(process.cwd());
  try {
    const first = needsBootstrap(board);
    const input = {
      id: options.values.get("--id") ?? "",
      displayName: options.values.get("--name") ?? "",
      password: options.values.get("--password") ?? "",
    };
    const user = first
      ? bootstrapAdmin(board, input)
      : createUser(board, { ...input, role: (options.values.get("--role") ?? "member") as Role });

    if (options.flags.has("--json")) {
      write(JSON.stringify({ user, bootstrapped: first }, null, 2));
    } else {
      write(`${first ? "Bootstrapped admin" : "Created user"} ${user.id} (${user.role})`);
      write("");
      write("  Identity is in users.yaml and is shared through git.");
      write("  The password hash is in .local/credentials.sqlite and never leaves this machine.");
    }
  } finally {
    board.close();
  }
}

function runUserCommand(args: string[]): void {
  const [sub, ...rest] = args;
  if (sub !== "list") {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  const options = parseArgs(rest, new Set(), new Set(["--json"]));
  const board = openBoard(process.cwd());
  try {
    const users = listUsers(board);
    if (options.flags.has("--json")) {
      write(JSON.stringify(users, null, 2));
      return;
    }
    if (users.length === 0) {
      write("No accounts yet. Create the first admin with: localjira admin create");
      return;
    }
    for (const user of users) {
      write(`${user.id.padEnd(16)} ${user.role.padEnd(8)} ${user.displayName}`);
    }
  } finally {
    board.close();
  }
}

async function runServeCommand(args: string[]): Promise<void> {
  const options = parseArgs(args, new Set(["--port", "--host"]), new Set());
  const server = await startServer({
    cwd: process.cwd(),
    port: options.values.has("--port") ? Number(options.values.get("--port")) : 4000,
    host: options.values.get("--host"),
  });

  write(`Local Jira listening on ${server.url}`);
  write("Press Ctrl+C to stop.");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void server.close().then(() => process.exit(0));
    });
  }
}

function printIndexStatus(status: IndexStatus): void {
  write(`Board: ${status.boardPath}`);
  if (status.boardId) {
    write(`Board id: ${status.boardId}`);
  }
  write(`Schema version: ${status.schemaVersion ?? "?"}`);
  write(`Last full rebuild: ${status.lastRebuildAt ?? "never"}`);

  const { mode, reason, stats } = status.refresh;
  write(
    `Refresh: ${mode} (${reason}) — scanned ${stats.scanned}, hashed ${stats.hashed}, ` +
      `parsed ${stats.parsed}, removed ${stats.removed} in ${stats.durationMs}ms`,
  );

  write("");
  for (const [label, count] of Object.entries(status.counts)) {
    write(`  ${label.padEnd(10)} ${String(count).padStart(6)}`);
  }

  if (status.errors.length > 0) {
    write("");
    write(`Files that could not be indexed (${status.errors.length}):`);
    for (const error of status.errors) {
      write(`  ! ${error.path}`);
      write(`      ${error.reason}${error.detail ? `: ${error.detail}` : ""}`);
    }
  }
}

function printIssueTable(issues: IssueSummary[]): void {
  if (issues.length === 0) {
    write("No issues.");
    return;
  }

  const width = (pick: (issue: IssueSummary) => string, min: number): number =>
    Math.max(min, ...issues.map((issue) => displayWidth(pick(issue))));

  const keyWidth = width((issue) => issue.key, 3);
  const statusWidth = width((issue) => issue.status ?? "", 6);
  const typeWidth = width((issue) => issue.type ?? "", 4);

  for (const issue of issues) {
    const points = issue.points === null ? "  -" : String(issue.points).padStart(3);
    const labels = issue.labels.length > 0 ? `  [${issue.labels.join(", ")}]` : "";
    write(
      `${pad(issue.key, keyWidth)}  ${pad(issue.status ?? "-", statusWidth)}  ` +
        `${pad(issue.type ?? "-", typeWidth)}  ${points}  ${issue.title ?? ""}${labels}`,
    );
  }
  write("");
  write(`${issues.length} issue(s)`);
}

function printIssueDetail(issue: IssueDetail): void {
  write(`${issue.key}  ${issue.title ?? ""}`);
  write("");
  write(`  uid       ${issue.uid}`);
  write(`  type      ${issue.type ?? "-"}`);
  write(`  status    ${issue.status ?? "-"}`);
  write(`  points    ${issue.points ?? "-"}`);
  write(`  assignee  ${issue.assignee ?? "-"}`);
  write(`  sprint    ${issue.sprint ?? "-"}`);
  write(`  labels    ${issue.labels.length > 0 ? issue.labels.join(", ") : "-"}`);
  write(`  file      ${issue.path}`);
  write(`  etag      ${issue.etag}`);
}

/** Hangul and other wide glyphs occupy two terminal cells. */
function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0x1f300 && code <= 0x1f64f)
        ? 2
        : 1;
  }
  return width;
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - displayWidth(value)));
}

interface ParsedArgs {
  values: Map<string, string>;
  /** Options given more than once, in the order they appeared. */
  repeated: Map<string, string[]>;
  flags: Set<string>;
}

function parseArgs(
  args: string[],
  valued: Set<string>,
  flags: Set<string>,
): ParsedArgs {
  const parsed: ParsedArgs = { values: new Map(), repeated: new Map(), flags: new Set() };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flags.has(arg)) {
      parsed.flags.add(arg);
      continue;
    }
    if (valued.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new BootstrapInputError(
          "E_INVALID_PROJECT_KEY",
          arg,
          `${arg} requires a value.`,
        );
      }
      parsed.values.set(arg, value);
      append(parsed, arg, value);
      index += 1;
      continue;
    }
    const [name, inlineValue] = splitInline(arg);
    if (inlineValue !== null && valued.has(name)) {
      parsed.values.set(name, inlineValue);
      append(parsed, name, inlineValue);
      continue;
    }
    throw new BootstrapInputError(
      "E_INVALID_PROJECT_KEY",
      arg,
      `Unknown argument: ${arg}`,
    );
  }

  return parsed;
}

function append(parsed: ParsedArgs, name: string, value: string): void {
  const existing = parsed.repeated.get(name);
  if (existing) {
    existing.push(value);
  } else {
    parsed.repeated.set(name, [value]);
  }
}

function splitInline(arg: string): [string, string | null] {
  const separator = arg.indexOf("=");
  return separator === -1
    ? [arg, null]
    : [arg.slice(0, separator), arg.slice(separator + 1)];
}

function report(result: CommandResult, json: boolean): void {
  if (json) {
    write(JSON.stringify(result, null, 2));
    return;
  }

  write(`Local Jira board: ${result.status}`);
  write(`Repository: ${result.repoRoot}`);
  write(`Board: ${result.boardPath}`);
  write(`Branch: ${result.branch}`);
  if (result.boardId) {
    write(`Board id: ${result.boardId}`);
  }
  for (const action of result.actions) {
    write(`- ${action}`);
  }
  for (const warning of result.warnings) {
    write(`! ${warning}`);
  }
}

function printDoctorReport(report: ReturnType<typeof inspectBootstrap>): void {
  write(`Local Jira bootstrap: ${report.status}`);
  if (report.repoRoot) {
    write(`Repository: ${report.repoRoot}`);
  }
  if (report.boardPath) {
    write(`Board: ${report.boardPath}`);
  }
  if (report.status === "UNINITIALIZED") {
    write("No localjira/data branch or board worktree exists.");
  }
  for (const issue of report.issues) {
    write(`- ${issue.code}: ${issue.message}`);
    if (issue.recovery) {
      write(`  Next: ${issue.recovery}`);
    }
  }
}

function reportFailure(error: unknown, json: boolean): void {
  const { code, message, recovery } = describeFailure(error);

  if (json) {
    write(JSON.stringify({ status: "error", code, message, recovery }, null, 2));
  } else {
    process.stderr.write(`${code}: ${message}\n`);
    if (recovery) {
      process.stderr.write(`Next: ${recovery}\n`);
    }
  }
  process.exitCode = 1;
}

function describeFailure(error: unknown): {
  code: string;
  message: string;
  recovery: string | null;
} {
  if (error instanceof BootstrapError) {
    return { code: error.code, message: error.message, recovery: error.recovery };
  }
  if (error instanceof BootstrapBusyError) {
    return {
      code: error.code,
      message: error.message,
      recovery: "Wait for the other bootstrap command to finish.",
    };
  }
  if (error instanceof BootstrapLockUnsupportedError) {
    return { code: error.code, message: error.message, recovery: null };
  }
  if (error instanceof BootstrapInputError) {
    return { code: error.code, message: error.message, recovery: null };
  }
  if (error instanceof IssueError) {
    return { code: error.code, message: error.message, recovery: error.detail };
  }
  if (error instanceof UserError) {
    return { code: error.code, message: error.message, recovery: error.detail };
  }
  if (error instanceof PasswordError) {
    return { code: error.code, message: error.message, recovery: null };
  }
  return {
    code: "E_UNEXPECTED",
    message: error instanceof Error ? error.message : String(error),
    recovery: null,
  };
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}
