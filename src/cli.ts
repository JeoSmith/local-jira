#!/usr/bin/env node

import process from "node:process";

import { inspectBootstrap } from "./bootstrap/doctor.ts";

const [command, ...args] = process.argv.slice(2);
const json = args.includes("--json");

if (command !== "doctor" || args.some((arg) => arg !== "--json")) {
  printUsage();
  process.exitCode = 2;
} else {
  const report = inspectBootstrap(process.cwd());

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHumanReport(report);
  }

  process.exitCode = report.ok || report.status === "UNINITIALIZED" ? 0 : 1;
}

function printUsage(): void {
  process.stderr.write("Usage: localjira doctor [--json]\n");
}

function printHumanReport(
  report: ReturnType<typeof inspectBootstrap>,
): void {
  process.stdout.write(`Local Jira bootstrap: ${report.status}\n`);
  if (report.repoRoot) {
    process.stdout.write(`Repository: ${report.repoRoot}\n`);
  }
  if (report.boardPath) {
    process.stdout.write(`Board: ${report.boardPath}\n`);
  }

  if (report.status === "UNINITIALIZED") {
    process.stdout.write("No localjira/data branch or board worktree exists.\n");
  }

  for (const issue of report.issues) {
    process.stdout.write(`- ${issue.code}: ${issue.message}\n`);
    if (issue.recovery) {
      process.stdout.write(`  Next: ${issue.recovery}\n`);
    }
  }
}
