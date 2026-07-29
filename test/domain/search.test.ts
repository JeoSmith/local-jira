import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer, type RunningServer } from "../../src/server/http.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const PASSWORD = "correct horse battery";

interface Session {
  server: RunningServer;
  cookie: string;
  repo: string;
  board: string;
  restart(): Promise<void>;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
}

function cli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

async function makeSession(t: { after: (fn: () => void) => void }): Promise<Session> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-search-")));
  const repo = path.join(root, "code");
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "s@example.com"]);
  git(repo, ["config", "user.name", "Search"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# code\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial"]);

  cli(repo, ["init", "--project-key", "LJ", "--project-name", "L", "--timezone", "UTC"]);
  cli(repo, ["admin", "create", "--id", "owner", "--name", "오너", "--password", PASSWORD]);

  const session = { repo, board: path.join(repo, ".localjira") } as Session;
  const boot = async (): Promise<void> => {
    session.server = await startServer({ cwd: repo, port: 0, watch: false });
    const login = await fetch(`${session.server.url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "owner", password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    session.cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  };
  session.restart = async () => {
    await session.server.close();
    await boot();
  };

  await boot();
  t.after(() => session.server.close());
  return session;
}

async function call(session: Session, method: string, route: string, body?: unknown) {
  const response = await fetch(`${session.server.url}${route}`, {
    method,
    headers: { "content-type": "application/json", cookie: session.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>),
  };
}

async function make(
  session: Session,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await call(session, "POST", "/issues", {
    project: "LJ", type: "task", title, ...extra,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.key as unknown as string;
}

async function search(session: Session, query: string): Promise<string[]> {
  const found = await call(session, "GET", `/issues?${query}`);
  assert.equal(found.status, 200, JSON.stringify(found.json));
  return (found.json as unknown as { issues: Array<{ key: string }> }).issues.map((i) => i.key);
}

test("finds words in the title, the body and the acceptance criteria", async (t) => {
  const session = await makeSession(t);
  const titled = await make(session, "가상 스크롤 개선");
  const bodied = await make(session, "무관한 제목", { description: "본문에 가상 스크롤 이야기" });
  const accepted = await make(session, "또 다른 제목", {
    acceptance: [{ text: "가상 스크롤이 끊기지 않는다" }],
  });
  await make(session, "전혀 상관없는 것");

  const hits = await search(session, "q=" + encodeURIComponent("스크롤"));
  assert.deepEqual(hits.sort(), [titled, bodied, accepted].sort());
});

test("a Korean particle does not hide a match", async (t) => {
  const session = await makeSession(t);
  const attached = await make(session, "스크롤을 개선한다");
  const plain = await make(session, "스크롤 개선");
  const inflected = await make(session, "스크롤에서 발생하는 문제");

  // The reason for trigram (S2-D2). Whitespace tokenizing makes 스크롤을 and
  // 스크롤에서 different words, and a search for 스크롤 finds neither — not
  // slower, just wrong.
  const hits = await search(session, "q=" + encodeURIComponent("스크롤"));
  assert.deepEqual(hits.sort(), [attached, plain, inflected].sort());
});

test("search combines with structured filters rather than replacing them", async (t) => {
  const session = await makeSession(t);
  const both = await make(session, "스크롤 성능", { labels: ["perf"] });
  await make(session, "스크롤 문서", { labels: ["docs"] });
  await make(session, "무관한 성능 작업", { labels: ["perf"] });

  const hits = await search(session, "q=" + encodeURIComponent("스크롤") + "&label=perf");
  assert.deepEqual(hits, [both]);
});

test("results say where they matched", async (t) => {
  const session = await makeSession(t);
  const key = await make(session, "제목에는 없음", {
    description: "본문 어딘가에 토크나이저라는 단어가 들어 있고 뒤에 다른 말이 이어진다",
  });

  const found = await call(session, "GET", `/issues?q=${encodeURIComponent("토크나이저")}`);
  const matches = (found.json as unknown as {
    matches: Record<string, { fields: string[]; snippet: string | null }>;
  }).matches;

  assert.deepEqual(matches[key].fields, ["body"], "the title did not match, the body did");
  assert.match(String(matches[key].snippet), /토크나이저/);
});

test("an old key still finds the issue that used to hold it", async (t) => {
  const session = await makeSession(t);
  await session.server.close();

  const early = "01J000000000000000000000AA";
  const later = "01J111111111111111111111BB";
  const directory = path.join(session.board, "issues", "LJ");
  fs.mkdirSync(directory, { recursive: true });
  for (const [file, uid, title] of [
    ["LJ-13.md", early, "원래 주인"],
    ["LJ-13-dup.md", later, "밀려날 것"],
  ] as const) {
    fs.writeFileSync(
      path.join(directory, file),
      `---\nuid: ${uid}\nkey: LJ-13\nformer_keys: []\ntype: task\ntitle: ${title}\nstatus: BACKLOG\n---\n\n`,
    );
  }
  await session.restart();

  // After rekeying, both issues answer to LJ-13 — one as its current key and
  // one as an alias — and the search has to show both, distinguishably (AC25).
  const found = await call(session, "GET", "/issues?q=LJ-13");
  const issues = (found.json as unknown as {
    issues: Array<{ key: string; uid: string }>;
    matches: Record<string, { fields: string[] }>;
  });

  assert.equal(issues.issues.length, 2, JSON.stringify(issues.issues));
  const current = issues.issues.find((issue) => issue.uid === early);
  const moved = issues.issues.find((issue) => issue.uid === later);
  assert.equal(current?.key, "LJ-13", "the original owner still holds the key");
  assert.equal(moved?.key, "LJ-14", "and the other one says where it lives now");
  assert.deepEqual(issues.matches[moved!.key].fields, ["key_alias"], "matched as an alias");
});

test("a two-letter search still works", async (t) => {
  const session = await makeSession(t);
  const key = await make(session, "보드 화면 정리");
  await make(session, "전혀 다른 것");

  // Trigram matches nothing below three characters, and does it silently — a
  // two-letter search would look like an empty board rather than a limitation.
  const hits = await search(session, "q=" + encodeURIComponent("보드"));
  assert.deepEqual(hits, [key]);
});

test("an empty query is a list, not an error", async (t) => {
  const session = await makeSession(t);
  const first = await make(session, "첫째");
  const second = await make(session, "둘째");

  for (const query of ["q=", "q=%20%20"]) {
    const hits = await search(session, query);
    assert.deepEqual(hits.sort(), [first, second].sort(), `${query} should list everything`);
  }
});

test("a quarantined issue is not searchable", async (t) => {
  const session = await makeSession(t);
  const healthy = await make(session, "스크롤 정상");
  const broken = await make(session, "스크롤 고장");

  fs.writeFileSync(
    path.join(session.board, "issues", "LJ", `${broken.slice(0)}.md`),
    "---\nuid: [unclosed\n---\n",
  );
  await session.server.reconcile();

  const hits = await search(session, "q=" + encodeURIComponent("스크롤"));
  assert.deepEqual(hits, [healthy], "a file the board cannot read is not a search result");
});

test("an external edit changes what is findable", async (t) => {
  const session = await makeSession(t);
  const key = await make(session, "예전 단어 포함");

  const file = path.join(session.board, "issues", "LJ", `${key}.md`);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace(/^title: .*$/m, "title: 새로운 단어 포함"),
  );
  await session.server.reconcile();

  assert.deepEqual(await search(session, "q=" + encodeURIComponent("새로운")), [key]);
  assert.deepEqual(await search(session, "q=" + encodeURIComponent("예전")), []);
});

test("the search index survives losing the database", async (t) => {
  const session = await makeSession(t);
  const key = await make(session, "재빌드 뒤에도 찾혀야 함", {
    description: "본문에도 토크나이저 이야기",
  });
  const before = await search(session, "q=" + encodeURIComponent("토크나이저"));
  assert.deepEqual(before, [key]);

  await session.server.close();
  fs.rmSync(path.join(session.board, ".local", "index.sqlite"));
  await session.restart();

  // AC2: the FTS index is derived from files like everything else in .local/.
  assert.deepEqual(await search(session, "q=" + encodeURIComponent("토크나이저")), before);
});

test("five thousand issues search inside the budget", { timeout: 180_000 }, async (t) => {
  const session = await makeSession(t);
  await session.server.close();

  const directory = path.join(session.board, "issues", "LJ");
  fs.mkdirSync(directory, { recursive: true });
  const stems = ["스크롤", "백로그", "인덱스", "스프린트", "드래그"];
  const particles = ["을", "이", "에서", "으로", ""];

  for (let index = 1; index <= 5_000; index += 1) {
    const stem = stems[index % stems.length];
    const particle = particles[index % particles.length];
    fs.writeFileSync(
      path.join(directory, `LJ-${index + 100}.md`),
      `---\nuid: 01JBIG${String(index).padStart(20, "0")}\nkey: LJ-${index + 100}\n` +
        `type: task\ntitle: ${stem}${particle} 개선 ${index}\nstatus: BACKLOG\n` +
        `backlog_rank: "${String(index).padStart(6, "0")}"\n---\n\n${stem}${particle} 관련 본문\n`,
    );
  }
  await session.restart();

  const timings: number[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const started = performance.now();
    const found = await call(session, "GET", `/issues?q=${encodeURIComponent("스크롤")}&limit=100`);
    assert.equal(found.status, 200);
    assert.ok(
      (found.json as unknown as { issues: unknown[] }).issues.length > 0,
      "the search found nothing at scale",
    );
    timings.push(performance.now() - started);
  }

  timings.sort((a, b) => a - b);
  const p95 = timings[Math.floor(timings.length * 0.95) - 1];
  assert.ok(p95 < 300, `p95 was ${p95.toFixed(0)}ms against a 300ms budget (AC13, N1)`);
  process.stdout.write(`      (5,000 issues, full-text: p95 ${p95.toFixed(0)}ms)\n`);
});
