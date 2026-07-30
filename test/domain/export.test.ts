import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COLUMNS, toCsv } from "../../src/domain/export.ts";
import { startServer, type RunningServer } from "../../src/server/http.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

interface Session {
  server: RunningServer;
  repo: string;
  board: string;
  admin: string;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout;
}

function cli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

async function call(
  s: Session,
  method: string,
  route: string,
  options: { body?: unknown; etag?: string } = {},
): Promise<{ status: number; json: Record<string, never>; etag: string | null }> {
  const response = await fetch(`${s.server.url}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: s.admin,
      ...(options.etag ? { "if-match": options.etag } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
    etag: response.headers.get("etag"),
  };
}

async function download(
  s: Session,
  route: string,
): Promise<{ status: number; body: string; headers: Headers }> {
  const response = await fetch(`${s.server.url}${route}`, { headers: { cookie: s.admin } });
  return { status: response.status, body: await response.text(), headers: response.headers };
}

async function session(t: {
  after: (fn: () => void | Promise<void>) => void;
}): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-exp-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);
  assert.equal(
    cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]).status,
    0,
  );
  cli(repo, ["admin", "create", "--id", "root", "--name", "루트", "--password", PASSWORD]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const server = await startServer({ cwd: repo, port: 0, watch: false });
  t.after(() => server.close());
  const login = await fetch(`${server.url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "root", password: PASSWORD }),
  });

  return {
    server, repo,
    board: path.join(repo, ".localjira"),
    admin: (login.headers.get("set-cookie") ?? "").split(";")[0],
  };
}

async function anIssue(
  s: Session,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await call(s, "POST", "/issues", {
    body: { project: "LJ", type: "task", title, ...extra },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.key as unknown as string;
}

function rowsOf(csv: string): string[][] {
  // Enough of RFC 4180 to read back what `toCsv` writes.
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const text = csv.replace(/^﻿/, "");

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\r") {
      // skip
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ── the file ────────────────────────────────────────────────────────────────

test("JSON matches the frontmatter, field for field", async (t) => {
  const s = await session(t);
  const key = await anIssue(s, "내보낼 이슈", {
    points: 5,
    labels: ["web", "perf"],
    acceptance: ["첫 조건", "둘째 조건"],
  });

  const found = await download(s, "/export.json");
  assert.equal(found.status, 200);
  const [row] = JSON.parse(found.body) as Array<Record<string, unknown>>;

  const file = fs.readFileSync(path.join(s.board, "issues", "LJ", `${key}.md`), "utf8");
  assert.equal(row.key, key);
  assert.equal(row.title, "내보낼 이슈");
  assert.equal(row.points, 5);
  // Sorted, because `requireLabels` sorts before writing. The export is
  // faithful to the file rather than to the request that made it.
  assert.deepEqual(row.labels, ["perf", "web"]);
  assert.equal(row.status, "BACKLOG");
  assert.equal(row.created_by_kind, "human");
  // §5.1, §5.3: the export is the document, so every value has to be in it.
  assert.ok(file.includes(`uid: ${row.uid as string}`));
  assert.ok(file.includes(`key: ${key}`));
});

test("nothing from the index leaks in", async (t) => {
  const s = await session(t);
  await anIssue(s, "검색될 이슈");

  const found = await download(s, "/export.json?q=검색");
  const [row] = JSON.parse(found.body) as Array<Record<string, unknown>>;

  // Derived values live only in the cache. Exporting them would make the file
  // depend on when it was taken rather than on what the board says.
  for (const leak of ["score", "matches", "rank", "indexed_at", "path", "etag", "state"]) {
    assert.equal(leak in row, false, `${leak} is index-only`);
  }
  assert.deepEqual(Object.keys(row).sort(), [...COLUMNS].sort());
});

test("times are passed through as stored", async (t) => {
  const s = await session(t);
  await anIssue(s, "시각 확인");

  const [row] = JSON.parse((await download(s, "/export.json")).body) as Array<
    Record<string, string>
  >;
  // §5.2: RFC 3339 as written. Reformatting for readability would make the
  // export lossy in the one field a spreadsheet is most likely to sort on.
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/);
  assert.equal(row.created_at, row.updated_at);
});

test("the same query gives the same file after the index is rebuilt", async (t) => {
  const s = await session(t);
  await anIssue(s, "첫", { points: 3, labels: ["a"] });
  await anIssue(s, "둘", { points: 5 });

  const before = await download(s, "/export.json");
  await call(s, "POST", "/index/rebuild");
  const after = await download(s, "/export.json");

  // AC2's property: the index is derived, so what comes out of the files cannot
  // depend on having kept it.
  assert.equal(after.body, before.body);
});

// ── CSV (S5-D6) ─────────────────────────────────────────────────────────────

test("the header is fixed, whatever the issues happen to hold", async (t) => {
  const s = await session(t);
  await anIssue(s, "라벨 없는 이슈");

  const bare = rowsOf((await download(s, "/export.csv")).body);
  await anIssue(s, "라벨 있는 이슈", { labels: ["x"], points: 8 });
  const full = rowsOf((await download(s, "/export.csv")).body);

  // A spreadsheet somebody built a formula against must not gain a column
  // because one issue had a label.
  assert.deepEqual(bare[0], [...COLUMNS]);
  assert.deepEqual(full[0], bare[0]);
});

test("a BOM, because this is opened in a spreadsheet", async (t) => {
  const s = await session(t);
  await anIssue(s, "한글 제목");

  // Read as bytes: `Response.text()` strips a leading BOM per spec, so a test
  // that looked at the decoded string would report it missing when it is there.
  const raw = await fetch(`${s.server.url}/export.csv`, { headers: { cookie: s.admin } });
  const bytes = new Uint8Array(await raw.arrayBuffer());
  assert.deepEqual(
    [...bytes.slice(0, 3)],
    [0xef, 0xbb, 0xbf],
    "Excel misreads UTF-8 without a BOM",
  );

  const found = await download(s, "/export.csv");
  assert.match(String(found.headers.get("content-type")), /text\/csv/);
  assert.match(String(found.headers.get("content-disposition")), /attachment; filename=/);
});

test("commas and quotes in a title survive the round trip", async (t) => {
  const s = await session(t);
  await anIssue(s, '쉼표, 그리고 "따옴표" 있는 제목');

  const rows = rowsOf((await download(s, "/export.csv")).body);
  const title = rows[1][COLUMNS.indexOf("title")];
  assert.equal(title, '쉼표, 그리고 "따옴표" 있는 제목');
});

test("a list is JSON, so a delimiter inside it is not a field break", async (t) => {
  const s = await session(t);
  // Not labels: those may not contain a comma at all (`requireLabels`). Free
  // text can, which is exactly where a delimiter-joined list would come apart.
  await anIssue(s, "쉼표 든 인수조건", {
    acceptance: ["given a, when b, then c", '따옴표 "포함"'],
  });

  const rows = rowsOf((await download(s, "/export.csv")).body);
  const acceptance = JSON.parse(rows[1][COLUMNS.indexOf("acceptance")]) as Array<{
    text: string;
  }>;

  // Joined with a delimiter this would be unrecoverable, and split into columns
  // the header would change with the number of criteria (S5-D6).
  assert.equal(acceptance.length, 2);
  assert.equal(acceptance[0].text, "given a, when b, then c");
  assert.equal(acceptance[1].text, '따옴표 "포함"');
});

test("an empty result is an empty file, not an error", async (t) => {
  const s = await session(t);

  const csv = await download(s, "/export.csv?q=존재하지않는검색어");
  assert.equal(csv.status, 200);
  assert.deepEqual(rowsOf(csv.body), [[...COLUMNS]], "header only");

  const json = await download(s, "/export.json?q=존재하지않는검색어");
  assert.equal(json.status, 200);
  assert.deepEqual(JSON.parse(json.body), []);
});

// ── what is left out ────────────────────────────────────────────────────────

test("the current filter is what comes out", async (t) => {
  const s = await session(t);
  await anIssue(s, "스크롤 성능 개선");
  await anIssue(s, "로그인 화면 정리");

  const found = await download(s, "/export.json?q=스크롤");
  const rows = JSON.parse(found.body) as Array<{ title: string }>;
  assert.equal(rows.length, 1, found.body);
  assert.equal(rows[0].title, "스크롤 성능 개선");
});

test("a quarantined issue is left out and its omission is stated", async (t) => {
  const s = await session(t);
  const broken = await anIssue(s, "깨질 이슈");
  await anIssue(s, "멀쩡한 이슈");

  fs.appendFileSync(
    path.join(s.board, "issues", "LJ", `${broken}.md`),
    "\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> z\n",
  );
  await call(s, "POST", "/index/rebuild");

  const excluded = await download(s, "/export.json");
  const rows = JSON.parse(excluded.body) as Array<{ key: string }>;
  assert.equal(rows.length, 1);
  // §5.6: silently dropping it would make the export claim a smaller board.
  assert.equal(excluded.headers.get("x-excluded-quarantined"), "1");
  assert.match(String(excluded.headers.get("x-excluded-paths")), new RegExp(`${broken}\\.md`));

  const included = await download(s, "/export.json?quarantined=include");
  const both = JSON.parse(included.body) as Array<{ key: string; quarantined: boolean }>;
  assert.equal(both.length, 2);
  const marked = both.find((row) => row.quarantined === true);
  assert.ok(marked, "included, and marked so it is not read as vouched for");
});

test("no runtime state and no secrets", async (t) => {
  const s = await session(t);
  await anIssue(s, "비밀 없나");

  const body = (await download(s, "/export.json")).body;
  // claim/lease is runtime state, not file SoT (§5.4). N6 keeps hashes and
  // tokens out of anything that leaves the machine.
  for (const forbidden of ["claim", "lease", "password", "token", "argon2", "credential"]) {
    assert.equal(body.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test("exporting writes nothing", async (t) => {
  const s = await session(t);
  await anIssue(s, "읽기만 한다");

  const before = git(s.board, ["status", "--porcelain", "-uall"]);
  const files = fs
    .readdirSync(path.join(s.board, "issues", "LJ"))
    .map((name) => fs.readFileSync(path.join(s.board, "issues", "LJ", name), "utf8"));

  await download(s, "/export.csv");
  await download(s, "/export.json");

  // D4, AC24: an export is a read. The badge must not move, and nothing may be
  // written under `.localjira/`.
  assert.equal(git(s.board, ["status", "--porcelain", "-uall"]), before);
  assert.deepEqual(
    fs
      .readdirSync(path.join(s.board, "issues", "LJ"))
      .map((name) => fs.readFileSync(path.join(s.board, "issues", "LJ", name), "utf8")),
    files,
  );
});

test("a project-scoped token exports only its project", async (t) => {
  const s = await session(t);
  fs.writeFileSync(
    path.join(s.board, "projects", "OP.yaml"),
    "schema_version: 1\nkey: OP\nname: 다른\ntimezone: UTC\nestimation_unit: story_points\n",
  );
  await call(s, "POST", "/index/rebuild");
  await anIssue(s, "LJ 이슈");
  await call(s, "POST", "/issues", { body: { project: "OP", type: "task", title: "OP 이슈" } });

  cli(s.repo, [
    "admin", "create", "--id", "bot", "--name", "봇", "--password", PASSWORD, "--role", "agent",
  ]);
  const issued = await call(s, "POST", "/tokens", {
    body: { user: "bot", scopes: ["issue:read"], project_scope: "LJ" },
  });

  const response = await fetch(`${s.server.url}/export.json`, {
    headers: { authorization: `Bearer ${issued.json.token as unknown as string}` },
  });
  const rows = (await response.json()) as Array<{ key: string }>;
  // The same narrowing the list route applies (S3-D9). An export that ignored
  // it would be the way around the boundary.
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.ok(rows[0].key.startsWith("LJ-"));
});

// ── the writer on its own ───────────────────────────────────────────────────

test("a null is empty, and false is false", () => {
  const csv = toCsv([
    Object.fromEntries(COLUMNS.map((column) => [column, null])),
    { ...Object.fromEntries(COLUMNS.map((column) => [column, null])), quarantined: false },
  ]);
  const rows = rowsOf(csv);

  // An empty cell and the text "null" are different things to a spreadsheet,
  // and so are "" and "false".
  assert.equal(rows[1][COLUMNS.indexOf("title")], "");
  assert.equal(rows[2][COLUMNS.indexOf("quarantined")], "false");
});
