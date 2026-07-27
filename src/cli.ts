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

const USAGE = `Usage:
  localjira doctor [--json]
  localjira init --project-key <KEY> --project-name <NAME> --timezone <TZ>
                 [--remote <NAME>] [--push] [--json]
  localjira repair-worktree [--remote <NAME>] [--json]
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

interface ParsedArgs {
  values: Map<string, string>;
  flags: Set<string>;
}

function parseArgs(
  args: string[],
  valued: Set<string>,
  flags: Set<string>,
): ParsedArgs {
  const parsed: ParsedArgs = { values: new Map(), flags: new Set() };

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
      index += 1;
      continue;
    }
    const [name, inlineValue] = splitInline(arg);
    if (inlineValue !== null && valued.has(name)) {
      parsed.values.set(name, inlineValue);
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
  return {
    code: "E_UNEXPECTED",
    message: error instanceof Error ? error.message : String(error),
    recovery: null,
  };
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}
