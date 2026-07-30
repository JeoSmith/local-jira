import { quarantineList } from "../storage/integrity.ts";
import type { BoardHandle } from "../storage/board.ts";

/**
 * The columns a CSV carries, in this order.
 *
 * Fixed rather than derived from what happens to be present, so two exports of
 * the same query produce the same header — a spreadsheet somebody built a
 * formula against must not gain a column because one issue had a label.
 */
export const COLUMNS = [
  "uid",
  "key",
  "former_keys",
  "type",
  "title",
  "status",
  "parent",
  "sprint",
  "assignee",
  "points",
  "labels",
  "links",
  "acceptance",
  "created_at",
  "updated_at",
  "created_by_kind",
  "quarantined",
] as const;

export interface ExportRow {
  [column: string]: unknown;
}

/**
 * Rows built from the domain documents, not from index columns.
 *
 * The frontmatter is what the file says; the index is a reading of it. Exporting
 * the reading would leak values that only exist in the cache (search score,
 * indexing time, tombstone bookkeeping) and would drift from the file the moment
 * the two disagreed.
 */
export function rowsFor(
  board: BoardHandle,
  issues: Array<{ uid: string; key: string }>,
  options: { includeQuarantined?: boolean } = {},
): { rows: ExportRow[]; excluded: Array<{ key: string | null; path: string }> } {
  const rows: ExportRow[] = [];
  for (const issue of issues) {
    const stored = board.db
      .prepare("SELECT resource_json FROM issues WHERE uid = ? AND state = 'OK'")
      .get(issue.uid) as { resource_json?: string } | undefined;
    if (!stored?.resource_json) {
      continue;
    }
    rows.push(toRow(JSON.parse(stored.resource_json) as Record<string, unknown>, false));
  }

  const excluded: Array<{ key: string | null; path: string }> = [];
  for (const entry of quarantineList(board.db)) {
    if (options.includeQuarantined === true) {
      const stored = board.db
        .prepare("SELECT resource_json FROM issues WHERE path = ?")
        .get(entry.path) as { resource_json?: string } | undefined;
      // Marked, not mixed in: §5.6 says the board cannot vouch for these, and a
      // row that looks like the others would be read as one it can.
      rows.push(
        stored?.resource_json
          ? toRow(JSON.parse(stored.resource_json) as Record<string, unknown>, true)
          : { ...blank(), key: entry.key, quarantined: true },
      );
    } else {
      excluded.push({ key: entry.key, path: entry.path });
    }
  }
  return { rows, excluded };
}

function blank(): ExportRow {
  return Object.fromEntries(COLUMNS.map((column) => [column, null]));
}

function toRow(resource: Record<string, unknown>, isQuarantined: boolean): ExportRow {
  const row = blank();
  for (const column of COLUMNS) {
    if (column === "quarantined") {
      row[column] = isQuarantined;
      continue;
    }
    // Times are passed through as stored. RFC 3339 is the format the files use,
    // and reformatting for readability would make the export lossy (§5.2).
    row[column] = resource[column] ?? null;
  }
  return row;
}

/**
 * CSV, with a BOM and nested fields as JSON (S5-D6).
 *
 * The BOM is there because this file exists to be opened in a spreadsheet, and
 * Excel misreads UTF-8 without one. Lists become JSON strings rather than
 * delimiter-joined text: a label containing the delimiter would otherwise be
 * unrecoverable, and one column per element would change the header from export
 * to export.
 */
export function toCsv(rows: ExportRow[]): string {
  const lines = [COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(COLUMNS.map((column) => cell(row[column])).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  // Quote whenever the text could be misread, and double any quote inside it —
  // RFC 4180's escape, which every spreadsheet understands.
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toJson(rows: ExportRow[]): string {
  return `${JSON.stringify(rows, null, 2)}\n`;
}
