/**
 * Checks the sprint document against the story files it summarises.
 *
 * Every number in the sprint document used to be typed by hand, and three of
 * them were wrong at least once: the undecided-question count, the estimate
 * total, and the per-milestone distribution. Worse, the document declared
 * "Wave 2 완료" while all six of those stories still read `status: draft` with
 * not one acceptance criterion ticked. Two records of the same fact disagreed
 * for days and nothing noticed, because nothing was comparing them.
 *
 * So the rule this enforces is narrow: a summary may not claim anything the
 * underlying files do not already say. It derives the totals itself and fails
 * on any disagreement, which makes the sprint document a view of the stories
 * rather than a second, competing source of truth.
 *
 * The board this project keeps of its own work is the same kind of summary and
 * drifted the same way: it went sixteen stories stale while saying M3 had not
 * been started. So it is compared here too, when it can be found — the whole
 * point of loading the work onto the board was that the tool would track
 * itself, and a record nothing checks is a record that quietly stops being
 * true.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STORY_DIR = path.join(ROOT, "jira-docs/2_requirements/story");
const SPRINT_DIR = path.join(ROOT, "jira-docs/4_plans/sprints");

/**
 * Every sprint document, not one named path.
 *
 * A checker that only knows about the sprint it was written for stops checking
 * the moment a second one appears — and the second one is where the numbers get
 * typed fresh and go wrong.
 */
function sprintDocuments(): string[] {
  return fs
    .readdirSync(SPRINT_DIR)
    .filter((name) => /^sprint-\d+-.*\.md$/.test(name) && !name.endsWith("-decisions.md"))
    .sort()
    .map((name) => path.join(SPRINT_DIR, name));
}

interface Story {
  id: string;
  file: string;
  status: string;
  ticked: number;
  total: number;
  carried: number;
}

/**
 * Where the board lives, or null when it is not reachable.
 *
 * `LOCALJIRA_BOARD` first so anybody can point this at one, then the worktree
 * list — ADR-006 makes the board a worktree of `localjira/data` in this very
 * repository, so git already knows where it is and nothing has to be
 * configured on a normal checkout.
 *
 * CI has neither: the data branch is not pushed, so the board simply is not
 * there. That is reported rather than failed, because a check that fails where
 * the thing it checks cannot exist teaches people to ignore it.
 */
function findBoard(): string | null {
  const named = process.env.LOCALJIRA_BOARD;
  if (named && fs.existsSync(path.join(named, "config.yaml"))) {
    return named;
  }

  try {
    const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const blocks = listed.split("\n\n");
    for (const block of blocks) {
      if (!/^branch refs\/heads\/localjira\/data$/m.test(block)) {
        continue;
      }
      const where = /^worktree (.+)$/m.exec(block)?.[1];
      if (where && fs.existsSync(path.join(where, "config.yaml"))) {
        return where;
      }
    }
  } catch {
    // No git, or no worktrees. Either way there is no board to compare.
  }
  return null;
}

/**
 * The story ids the board holds, and whether it calls each one done.
 *
 * Read from the files rather than through the API or the index: the index is a
 * cache that may not exist, and a server may not be running. The files are the
 * source of truth (ADR-001), which is exactly why this can read them directly.
 */
function readBoard(board: string): Map<string, string> | null {
  const directory = path.join(board, "issues");
  if (!fs.existsSync(directory)) {
    return null;
  }

  const found = new Map<string, string>();
  const walk = (from: string): void => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const absolute = path.join(from, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.name.endsWith(".md")) {
        continue;
      }
      const text = fs.readFileSync(absolute, "utf8");
      // The title carries the story id, which is how the load put them on:
      // `r13a PAT 발급·폐기·만료 수명 주기`.
      const title = /^title:\s*(.+)$/m.exec(text)?.[1] ?? "";
      const id = /^"?(r\d{2}[a-z]?)\b/.exec(title.trim())?.[1];
      if (id === undefined) {
        continue;
      }
      found.set(id, /^status:\s*(\S+)\s*$/m.exec(text)?.[1] ?? "(none)");
    }
  };
  walk(directory);
  return found;
}

/**
 * The board status a story's `status:` implies, or null when it implies none.
 *
 * Only the two ends are pinned. `draft` says nothing about where a story sits
 * on the board — it may be waiting, planned, or half built — and a checker that
 * guessed would fail on ordinary work. `withdrawn` is here because D16 created
 * that state and nothing was checking it: a story can be withdrawn in the file
 * while the board still lists it as work to do, which is precisely the drift
 * this script exists to catch.
 */
function boardStatusFor(storyStatus: string): string | null {
  if (storyStatus === "done") return "DONE";
  if (storyStatus === "withdrawn") return "CANCELLED";
  return null;
}

/** What the board says versus what the story files say. */
function compareBoard(stories: Map<string, Story>, say: (message: string) => void): string {
  const board = findBoard();
  if (board === null) {
    return "보드를 찾지 못해 대조를 건너뜁니다 (LOCALJIRA_BOARD 또는 localjira/data worktree).";
  }

  const onBoard = readBoard(board);
  if (onBoard === null) {
    return `${board}에 이슈가 없어 대조를 건너뜁니다.`;
  }

  let missing = 0;
  let wrong = 0;
  for (const [id, story] of stories) {
    const boardStatus = onBoard.get(id);
    if (boardStatus === undefined) {
      missing += 1;
      say(`보드에 ${id}가 없습니다. 스토리 파일에는 있습니다.`);
      continue;
    }

    const expected = boardStatusFor(story.status);
    // A story the file does not pin may sit anywhere on the board, but it may
    // not sit at one of the two ends — those are claims the file would have to
    // agree with.
    const wrongly =
      expected === null
        ? boardStatus === "DONE" || boardStatus === "CANCELLED"
        : boardStatus !== expected;

    if (wrongly) {
      wrong += 1;
      say(
        `보드의 ${id}는 ${boardStatus}인데 스토리 파일은 ${story.status}입니다` +
          `${expected === null ? "" : ` (${expected}이어야 합니다)`}.`,
      );
    }
  }

  return missing === 0 && wrong === 0
    ? `보드와 스토리가 일치합니다 (${onBoard.size}건).`
    : `보드가 스토리와 어긋납니다: 누락 ${missing}건, 상태 불일치 ${wrong}건.`;
}

interface Wave {
  number: string;
  stories: string[];
  points: number;
  complete: boolean;
}

const problems: string[] = [];

function fail(message: string): void {
  problems.push(message);
}

// ── the stories, as they actually are on disk ───────────────────────────────

function readStories(): Map<string, Story> {
  const stories = new Map<string, Story>();

  for (const file of fs.readdirSync(STORY_DIR).sort()) {
    if (!file.endsWith(".md") || file === "README.md") {
      continue;
    }
    const id = file.split("-")[0];
    const text = fs.readFileSync(path.join(STORY_DIR, file), "utf8");

    const ticked = (text.match(/^- \[x\]/gm) ?? []).length;
    const open = (text.match(/^- \[ \]/gm) ?? []).length;
    // An open box is only acceptable when it names where it went instead.
    const carried = (text.match(/\*\*→ 이월:/g) ?? []).length;

    stories.set(id, {
      id,
      file,
      status: /^status:\s*(\S+)/m.exec(text)?.[1] ?? "(none)",
      ticked,
      total: ticked + open,
      carried,
    });
  }
  return stories;
}

// ── what the sprint document claims ─────────────────────────────────────────

function readEstimates(doc: string): Map<string, number> {
  const points = new Map<string, number>();
  // | r09 원자적 저장·outbox 복구 | **13** | 근거… |
  for (const [, id, value] of doc.matchAll(/^\|\s*(r\d+[a-z]?)\s[^|]*\|\s*\*\*(\d+)\*\*\s*\|/gm)) {
    if (points.has(id)) {
      fail(`추정 표에 ${id}가 두 번 나옵니다.`);
    }
    points.set(id, Number(value));
  }
  return points;
}

function readWaves(doc: string): Wave[] {
  const waves: Wave[] = [];
  // | **2** | r08b · r09 · r10 · r01b · r12b · r14a | 31 | ✅ 완료… |
  for (const [, number, list, value, status] of doc.matchAll(
    /^\|\s*\*{0,2}(\d)\*{0,2}\s*\|\s*([^|]*?)\s*\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|$/gm,
  )) {
    waves.push({
      number,
      stories: [...list.matchAll(/r\d+[a-z]?/g)].map((match) => match[0]),
      points: Number(value),
      complete: status.includes("✅"),
    });
  }
  return waves;
}

function frontmatterNumber(doc: string, key: string): number | null {
  const found = new RegExp(`^${key}:\\s*(\\d+)`, "m").exec(doc);
  return found ? Number(found[1]) : null;
}

// ── the comparisons ─────────────────────────────────────────────────────────

function main(): void {
  const stories = readStories();
  const documents = sprintDocuments();

  if (documents.length === 0) {
    fail("스프린트 문서를 하나도 찾지 못했습니다.");
    report();
    return;
  }

  let totalWaves = 0;
  let earnedAll = 0;
  let scopeAll = 0;

  for (const file of documents) {
    const label = path.basename(file);
    const doc = fs.readFileSync(file, "utf8");
    const estimates = readEstimates(doc);
    const waves = readWaves(doc);

    if (waves.length === 0 || estimates.size === 0) {
      fail(`${label}: 웨이브 표 또는 추정 표를 읽지 못했습니다. 형식이 바뀌었나요?`);
      continue;
    }
    totalWaves += waves.length;

    const say = (message: string): void => fail(`${label}: ${message}`);
    const wavePoints = waves.reduce((sum, wave) => sum + wave.points, 0);
    const earned = waves.filter((wave) => wave.complete).reduce((sum, w) => sum + w.points, 0);
    scopeAll += wavePoints;
    earnedAll += earned;

    checkOne(doc, stories, estimates, waves, say);
  }

  report(stories, earnedAll, scopeAll, totalWaves);
}

function checkOne(
  doc: string,
  stories: Map<string, Story>,
  estimates: Map<string, number>,
  waves: Wave[],
  say: (message: string) => void,
): void {
  // 1. the estimate table adds up to the total it prints
  const declaredTotal = Number(/^\|\s*\*\*합계\*\*\s*\|\s*\*\*(\d+)\*\*/m.exec(doc)?.[1] ?? "-1");
  const actualTotal = [...estimates.values()].reduce((sum, value) => sum + value, 0);
  if (declaredTotal !== actualTotal) {
    say(`추정 합계가 ${declaredTotal}점이라고 적혀 있지만 행을 더하면 ${actualTotal}점입니다.`);
  }

  // 2. every story named in a wave has an estimate and a file
  for (const wave of waves) {
    for (const id of wave.stories) {
      if (!estimates.has(id)) {
        say(`Wave ${wave.number}의 ${id}가 추정 표에 없습니다.`);
      }
      if (!stories.has(id)) {
        say(`Wave ${wave.number}의 ${id}에 해당하는 스토리 파일이 없습니다.`);
      }
    }
    const summed = wave.stories.reduce((sum, id) => sum + (estimates.get(id) ?? 0), 0);
    if (summed !== wave.points) {
      say(`Wave ${wave.number}는 ${wave.points}점이라고 적혀 있지만 스토리를 더하면 ${summed}점입니다.`);
    }
  }

  // 3. the frontmatter agrees with the wave table
  const scopePoints = frontmatterNumber(doc, "scope_points");
  const scopeCount = frontmatterNumber(doc, "scope_count");
  const carriedOver = frontmatterNumber(doc, "carried_over");
  const wavePoints = waves.reduce((sum, wave) => sum + wave.points, 0);
  const waveStories = waves.reduce((sum, wave) => sum + wave.stories.length, 0);

  if (scopePoints !== wavePoints) {
    say(`frontmatter의 scope_points=${scopePoints}가 웨이브 합계 ${wavePoints}점과 다릅니다.`);
  }
  if (scopeCount !== waveStories) {
    say(`frontmatter의 scope_count=${scopeCount}가 웨이브에 담긴 ${waveStories}건과 다릅니다.`);
  }
  if (carriedOver !== null && scopeCount !== null && estimates.size - scopeCount !== carriedOver) {
    say(
      `frontmatter의 carried_over=${carriedOver}가 추정 표 ${estimates.size}건 − 범위 ${scopeCount}건 ` +
        `= ${estimates.size - scopeCount}건과 다릅니다.`,
    );
  }

  // 4. the progress line is derived, not asserted
  const progress = /\*\*(\d+)\s*\/\s*(\d+)점\s*\((\d+)%\)\*\*/.exec(doc);
  if (!progress) {
    say("진행 현황의 `**X / Y점 (Z%)**` 줄을 찾지 못했습니다.");
  } else {
    const [, done, total, percent] = progress.map(Number);
    const earned = waves.filter((wave) => wave.complete).reduce((sum, w) => sum + w.points, 0);
    if (done !== earned) {
      say(`진행이 ${done}점이라고 적혀 있지만 완료 표시된 웨이브의 합은 ${earned}점입니다.`);
    }
    if (total !== wavePoints) {
      say(`진행의 분모 ${total}점이 웨이브 합계 ${wavePoints}점과 다릅니다.`);
    }
    const expected = Math.round((earned / wavePoints) * 100);
    if (percent !== expected) {
      say(`진행률이 ${percent}%로 적혀 있지만 ${earned}/${wavePoints}는 ${expected}%입니다.`);
    }
  }

  // 5. "완료" means the stories say so too
  for (const wave of waves) {
    const members = wave.stories
      .map((id) => stories.get(id))
      .filter((story): story is Story => story !== undefined);

    if (wave.complete) {
      for (const story of members.filter((entry) => entry.status !== "done")) {
        say(`Wave ${wave.number}는 완료로 표시됐는데 ${story.file}의 status가 "${story.status}"입니다.`);
      }
    } else if (members.length > 0 && members.every((story) => story.status === "done")) {
      say(
        `Wave ${wave.number}의 스토리가 모두 done인데 웨이브가 완료로 표시되지 않았습니다. ` +
          "진행 현황 표와 진행 점수를 갱신하세요.",
      );
    }

    for (const story of members) {
      if (story.status === "done" && story.ticked + story.carried !== story.total) {
        say(
          `${story.file}: 인수조건 ${story.total}건 중 충족 ${story.ticked} + 이월 ${story.carried}건뿐입니다. ` +
            "남은 항목은 이월 대상을 적거나 체크해야 합니다.",
        );
      }
    }
  }

  // 6. the acceptance-criteria tally in the prose matches the boxes
  const tally = /인수조건 (\d+)건 중 \*\*(\d+)건 충족, (\d+)건 이월\*\*/.exec(doc);
  if (tally) {
    const wave2 = waves.find((wave) => wave.number === "2");
    const scope = (wave2?.stories ?? [])
      .map((id) => stories.get(id))
      .filter((story): story is Story => story !== undefined);

    const sum = (pick: (story: Story) => number): number =>
      scope.reduce((total, story) => total + pick(story), 0);

    const counted = [sum((s) => s.total), sum((s) => s.ticked), sum((s) => s.carried)];
    const claimed = [Number(tally[1]), Number(tally[2]), Number(tally[3])];
    const labels = ["전체", "충족", "이월"];

    counted.forEach((value, index) => {
      if (value !== claimed[index]) {
        say(`인수조건 ${labels[index]}이 ${claimed[index]}건으로 적혀 있지만 실제로는 ${value}건입니다.`);
      }
    });
  }
}

function report(
  stories?: Map<string, Story>,
  earned?: number,
  total?: number,
  waves?: number,
): void {
  if (stories && earned !== undefined && total !== undefined) {
    const done = [...stories.values()].filter((story) => story.status === "done");
    const percent = total === 0 ? 0 : Math.round((earned / total) * 100);
    process.stdout.write(
      `스토리 ${stories.size}건 · 완료 ${done.length}건 · ` +
        `웨이브 ${waves ?? 0}개 · 전체 진행 ${earned}/${total}점 (${percent}%)\n`,
    );
  }

  const boardNote = compareBoard(stories, (message) => fail(`보드: ${message}`));
  process.stdout.write(`${boardNote}\n`);

  if (problems.length === 0) {
    process.stdout.write("문서와 스토리가 일치합니다.\n");
    return;
  }

  process.stderr.write(`\n문서와 스토리가 어긋납니다 (${problems.length}건):\n`);
  for (const problem of problems) {
    process.stderr.write(`  - ${problem}\n`);
  }
  process.exitCode = 1;
}

main();
