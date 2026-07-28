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
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STORY_DIR = path.join(ROOT, "jira-docs/2_requirements/story");
const SPRINT_DOC = path.join(ROOT, "jira-docs/4_plans/sprints/sprint-01-m1-reliable-core.md");

interface Story {
  id: string;
  file: string;
  status: string;
  ticked: number;
  total: number;
  carried: number;
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
  const doc = fs.readFileSync(SPRINT_DOC, "utf8");
  const stories = readStories();
  const estimates = readEstimates(doc);
  const waves = readWaves(doc);

  if (waves.length === 0 || estimates.size === 0) {
    fail("스프린트 문서에서 웨이브 표 또는 추정 표를 읽지 못했습니다. 형식이 바뀌었나요?");
    report();
    return;
  }

  // 1. the estimate table adds up to the total it prints
  const declaredTotal = Number(/^\|\s*\*\*합계\*\*\s*\|\s*\*\*(\d+)\*\*/m.exec(doc)?.[1] ?? "-1");
  const actualTotal = [...estimates.values()].reduce((sum, value) => sum + value, 0);
  if (declaredTotal !== actualTotal) {
    fail(`추정 합계가 ${declaredTotal}점이라고 적혀 있지만 행을 더하면 ${actualTotal}점입니다.`);
  }

  // 2. every story named in a wave has an estimate, and exists as a file
  for (const wave of waves) {
    for (const id of wave.stories) {
      if (!estimates.has(id)) {
        fail(`Wave ${wave.number}의 ${id}가 추정 표에 없습니다.`);
      }
      if (!stories.has(id)) {
        fail(`Wave ${wave.number}의 ${id}에 해당하는 스토리 파일이 없습니다.`);
      }
    }
    // 3. the wave's printed points are the sum of its own stories
    const summed = wave.stories.reduce((sum, id) => sum + (estimates.get(id) ?? 0), 0);
    if (summed !== wave.points) {
      fail(`Wave ${wave.number}는 ${wave.points}점이라고 적혀 있지만 스토리를 더하면 ${summed}점입니다.`);
    }
  }

  // 4. the frontmatter agrees with the wave table
  const scopePoints = frontmatterNumber(doc, "scope_points");
  const scopeCount = frontmatterNumber(doc, "scope_count");
  const carriedOver = frontmatterNumber(doc, "carried_over");

  const wavePoints = waves.reduce((sum, wave) => sum + wave.points, 0);
  const waveStories = waves.reduce((sum, wave) => sum + wave.stories.length, 0);

  if (scopePoints !== wavePoints) {
    fail(`frontmatter의 scope_points=${scopePoints}가 웨이브 합계 ${wavePoints}점과 다릅니다.`);
  }
  if (scopeCount !== waveStories) {
    fail(`frontmatter의 scope_count=${scopeCount}가 웨이브에 담긴 ${waveStories}건과 다릅니다.`);
  }
  if (carriedOver !== null && scopeCount !== null && estimates.size - scopeCount !== carriedOver) {
    fail(
      `frontmatter의 carried_over=${carriedOver}가 추정 표 ${estimates.size}건 − 범위 ${scopeCount}건 ` +
        `= ${estimates.size - scopeCount}건과 다릅니다.`,
    );
  }

  // 5. the progress line is derived, not asserted
  const progress = /\*\*(\d+)\s*\/\s*(\d+)점\s*\((\d+)%\)\*\*/.exec(doc);
  if (!progress) {
    fail("진행 현황의 `**X / Y점 (Z%)**` 줄을 찾지 못했습니다.");
  } else {
    const [, done, total, percent] = progress.map(Number);
    const earned = waves.filter((wave) => wave.complete).reduce((sum, wave) => sum + wave.points, 0);
    if (done !== earned) {
      fail(`진행이 ${done}점이라고 적혀 있지만 완료 표시된 웨이브의 합은 ${earned}점입니다.`);
    }
    if (total !== wavePoints) {
      fail(`진행의 분모 ${total}점이 웨이브 합계 ${wavePoints}점과 다릅니다.`);
    }
    const expected = Math.round((earned / wavePoints) * 100);
    if (percent !== expected) {
      fail(`진행률이 ${percent}%로 적혀 있지만 ${earned}/${wavePoints}는 ${expected}%입니다.`);
    }
  }

  // 6. "완료" in the wave table means the stories say so too
  //
  // This is the one that was actually wrong: the document announced Wave 2 as
  // passed while every story in it was still a draft with 0 of 68 boxes ticked.
  for (const wave of waves) {
    const members = wave.stories
      .map((id) => stories.get(id))
      .filter((story): story is Story => story !== undefined);

    // A wave in progress may hold finished stories — that is what progress
    // looks like. The two claims worth checking are the absolute ones: a wave
    // called complete has nothing unfinished in it, and a wave with nothing
    // unfinished has been called complete.
    if (wave.complete) {
      for (const story of members.filter((entry) => entry.status !== "done")) {
        fail(`Wave ${wave.number}는 완료로 표시됐는데 ${story.file}의 status가 "${story.status}"입니다.`);
      }
    } else if (members.length > 0 && members.every((story) => story.status === "done")) {
      fail(
        `Wave ${wave.number}의 스토리가 모두 done인데 웨이브가 완료로 표시되지 않았습니다. ` +
          "진행 현황 표와 진행 점수를 갱신하세요.",
      );
    }

    for (const id of wave.stories) {
      const story = stories.get(id);
      if (!story) {
        continue;
      }
      // A finished story may leave criteria open only by naming where each went.
      if (story.status === "done" && story.ticked + story.carried !== story.total) {
        fail(
          `${story.file}: 인수조건 ${story.total}건 중 충족 ${story.ticked} + 이월 ${story.carried}건뿐입니다. ` +
            "남은 항목은 이월 대상을 적거나 체크해야 합니다.",
        );
      }
    }
  }

  // 7. the acceptance-criteria tally in the prose matches the boxes
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
        fail(`인수조건 ${labels[index]}이 ${claimed[index]}건으로 적혀 있지만 실제로는 ${value}건입니다.`);
      }
    });
  }

  report(stories, waves, wavePoints);
}

function report(stories?: Map<string, Story>, waves?: Wave[], total?: number): void {
  if (stories && waves && total !== undefined) {
    const earned = waves.filter((wave) => wave.complete).reduce((sum, wave) => sum + wave.points, 0);
    const done = [...stories.values()].filter((story) => story.status === "done");
    process.stdout.write(
      `스토리 ${stories.size}건 · 완료 ${done.length}건 · ` +
        `진행 ${earned}/${total}점 (${Math.round((earned / total) * 100)}%)\n`,
    );
  }

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
