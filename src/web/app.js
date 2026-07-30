const STATUS_ORDER = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "BLOCKED",
  "DONE",
  "CANCELLED",
];

const STATUS_LABELS = {
  BACKLOG: "백로그",
  TODO: "할 일",
  IN_PROGRESS: "진행 중",
  IN_REVIEW: "검토",
  BLOCKED: "차단됨",
  DONE: "완료",
  CANCELLED: "취소",
};

const state = { issues: [], user: null, source: null, detail: null, integrityOpen: false,
  view: "board", board: null, dragging: null, git: null };
const $ = (selector) => document.querySelector(selector);

document.addEventListener("DOMContentLoaded", boot);
$("#login-form").addEventListener("submit", login);
$("#logout-button").addEventListener("click", logout);
$("#project-filter").addEventListener("change", renderBoard);
$("#detail-close").addEventListener("click", closeDetail);
$("#integrity-banner").addEventListener("click", toggleIntegrity);
$("#settings-toggle").addEventListener("click", toggleSettings);
$("#token-form").addEventListener("submit", issueToken);
$("#git-badge").addEventListener("click", toggleGitPanel);
$("#view-board").addEventListener("click", () => void switchView("board"));
$("#view-backlog").addEventListener("click", () => void switchView("backlog"));
$("#index-verify").addEventListener("click", () => void runIndexOp("verify"));
$("#index-rebuild").addEventListener("click", () => void runIndexOp("rebuild"));
$("#timeline-more").addEventListener("click", () => void loadActivity(true));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.detail) closeDetail();
});

async function boot() {
  try {
    const payload = await api("/me");
    showBoard(payload.user);
    await refreshIssues();
    await refreshIntegrity();
    await refreshGit();
    connectEvents();
  } catch (error) {
    if (error.status === 401) {
      showLogin(error.code === "E_BOOTSTRAP_REQUIRED" ? error.message : "");
      return;
    }
    showLogin("서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
  }
}

async function login(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  const errorElement = $("#login-error");
  button.disabled = true;
  errorElement.hidden = true;

  try {
    const form = new FormData(event.currentTarget);
    const payload = await api("/auth/login", {
      method: "POST",
      body: { id: form.get("id"), password: form.get("password") },
    });
    showBoard(payload.user);
    await refreshIssues();
    await refreshIntegrity();
    await refreshGit();
    connectEvents();
  } catch (error) {
    errorElement.textContent = error.message || "로그인하지 못했습니다.";
    errorElement.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  state.source?.close();
  state.source = null;
  await api("/auth/logout", { method: "POST" }).catch(() => undefined);
  showLogin("");
}

function showLogin(message) {
  $("#board-view").hidden = true;
  $("#login-view").hidden = false;
  $("#login-error").textContent = message;
  $("#login-error").hidden = !message;
}

function showBoard(user) {
  state.user = user;
  $("#login-view").hidden = true;
  $("#board-view").hidden = false;
  $("#user-name").textContent = user.displayName || user.id;
}

async function refreshIssues() {
  try {
    const payload = await api("/issues?limit=5000");
    state.issues = payload.issues;
    updateProjectFilter();
    if (state.view === "board") await loadBoard();
    renderBoard();
    $("#board-error").hidden = true;
  } catch (error) {
    if (error.status === 401) {
      state.source?.close();
      state.source = null;
      showLogin("세션이 만료되었습니다. 다시 로그인해 주세요.");
      return;
    }
    $("#board-error").textContent = error.message || "이슈를 불러오지 못했습니다.";
    $("#board-error").hidden = false;
  }
}

function updateProjectFilter() {
  const select = $("#project-filter");
  const selected = select.value;
  const projects = [...new Set(state.issues.map((issue) => issue.project))].sort();
  select.replaceChildren(new Option("모든 프로젝트", ""));
  for (const project of projects) select.add(new Option(project, project));
  select.value = projects.includes(selected) ? selected : "";
}

function renderBoard() {
  const selectedProject = $("#project-filter").value;
  const issues = selectedProject
    ? state.issues.filter((issue) => issue.project === selectedProject)
    : state.issues;
  const board = $("#board");
  board.replaceChildren();

  // On the board the source is the sprint's scope; on the backlog it is
  // everything not in a sprint. Two questions, two lists.
  const scoped = state.view === "board"
    ? (state.board?.issues ?? [])
    : issues.filter((issue) => !issue.sprint);

  renderSprintLine();

  if (state.view === "board" && !state.board?.sprint) {
    const conflicted = state.board?.reason === "sprint_conflict";
    $("#empty-title").textContent = conflicted
      ? "어느 스프린트가 진행 중인지 확정할 수 없습니다."
      : "진행 중인 스프린트가 없습니다.";
    $("#empty-detail").textContent = conflicted
      ? "ACTIVE 스프린트가 둘 이상입니다. 위 배너에서 충돌한 파일을 확인해 한쪽을 고치면 시작·종료가 다시 허용됩니다."
      : "설정에서 스프린트를 만들고 시작하면 여기에 스코프가 표시됩니다. 그때까지는 백로그 탭을 쓰세요.";
    $("#board-empty").hidden = false;
    board.hidden = true;
    $("#board-summary").textContent = "";
    return;
  }

  $("#board-empty").hidden = scoped.length !== 0;
  $("#empty-title").textContent = "아직 등록된 이슈가 없습니다.";
  $("#empty-detail").textContent = "CLI 또는 API에서 이슈를 만들면 여기에 바로 나타납니다.";
  board.hidden = scoped.length === 0;

  const points = scoped.reduce((total, issue) => total + (issue.points || 0), 0);
  $("#board-summary").textContent = `${scoped.length}개 이슈 · ${points} 포인트`;

  const statuses = [...STATUS_ORDER];
  for (const status of new Set(scoped.map((issue) => issue.status || "BACKLOG"))) {
    if (!statuses.includes(status)) statuses.push(status);
  }

  for (const status of statuses) {
    const columnIssues = scoped.filter((issue) => (issue.status || "BACKLOG") === status);
    // BLOCKED and CANCELLED appear only when they hold something: a column that
    // is empty on every board is dead space, but hiding a full one hides work.
    if (!columnIssues.length && ["BLOCKED", "CANCELLED"].includes(status)) continue;
    board.append(renderColumn(status, columnIssues));
  }
}

/**
 * Moving a card, whether by mouse or keyboard.
 *
 * Two requests, not one: the transition and the position are separate changes
 * with separate rules, and folding them into a combined endpoint would make a
 * third way to change status alongside the transition route. The status goes
 * first because it is the durable meaning — the transition table governs it and
 * the event records it — while the position within a column is presentation. If
 * the rank call fails afterwards the card is in the right column at a
 * deterministic place, which the next drag corrects; the other order would rank
 * a card inside a column it is not in yet.
 */
async function moveCard(issue, toStatus, before) {
  const from = issue.status || "BACKLOG";

  // Refused here before it is sent when the table says so, using the list the
  // server computed. The card should not travel and come back.
  if (toStatus !== from && !(issue.allowed_to || []).includes(toStatus)) {
    const target = STATUS_LABELS[toStatus] || toStatus;
    announce(
      `${STATUS_LABELS[from] || from}에서 ${target}${josaEuro(target)}는 옮길 수 없습니다.` +
        ` 가능한 이동: ${(issue.allowed_to || []).map((s) => STATUS_LABELS[s] || s).join(", ") || "없음"}`,
      true,
    );
    return false;
  }

  try {
    if (toStatus !== from) {
      const current = await api(`/issues/${encodeURIComponent(issue.key)}`);
      await api(`/issues/${encodeURIComponent(issue.key)}/transitions`, {
        method: "POST",
        ifMatch: current.__etag,
        body: { to: toStatus },
      });
    }
    if (before !== undefined) {
      await api(`/issues/${encodeURIComponent(issue.key)}/rank`, {
        method: "POST",
        body: { field: "board_rank", after: before.after, before: before.before },
      });
    }
    const landed = STATUS_LABELS[toStatus] || toStatus;
    announce(`${issue.key}${josaEul(issue.key)} ${landed}${josaEuro(landed)} 옮겼습니다.`);
    return true;
  } catch (error) {
    announce(moveFailure(error), true);
    return false;
  } finally {
    await refreshIssues();
  }
}

/**
 * The keyboard equivalent of a drag.
 *
 * Left and right cross columns, up and down reorder within one. Same rules and
 * the same refusals as the mouse path — they go through `moveCard`, so there is
 * one place where a move is decided rather than two that can disagree.
 */
async function moveByKeyboard(issue, key) {
  const columns = (state.board?.columns ?? [])
    .filter((column) => column.always || column.count > 0)
    .map((column) => column.status);
  const here = issue.status || "BACKLOG";
  const at = columns.indexOf(here);

  if (key === "ArrowLeft" || key === "ArrowRight") {
    const target = columns[at + (key === "ArrowRight" ? 1 : -1)];
    if (!target) {
      return void announce("더 이동할 컬럼이 없습니다.", true);
    }
    // Land at the end of the target column. Sending "no neighbours either side"
    // would claim the column is empty, and the server refuses that when it is
    // not — the position has to describe the list as it actually is.
    const landing = (state.board?.issues ?? []).filter(
      (entry) => (entry.status || "BACKLOG") === target && entry.key !== issue.key,
    );
    const moved = await moveCard(issue, target, neighboursAt(landing, landing.length, issue.key));
    if (moved) focusCard(issue.key);
    return;
  }

  const column = (state.board?.issues ?? []).filter(
    (entry) => (entry.status || "BACKLOG") === here,
  );
  const index = column.findIndex((entry) => entry.key === issue.key);
  const to = index + (key === "ArrowDown" ? 1 : -1);
  if (to < 0 || to >= column.length) {
    return void announce("더 이동할 자리가 없습니다.", true);
  }

  const moved = await moveCard(issue, here, neighboursAt(column, to, issue.key));
  if (moved) focusCard(issue.key);
}

/** Puts focus back on the card after a re-render, so the keyboard path keeps
 *  its place. A refused move leaves focus where it was to begin with. */
function focusCard(key) {
  requestAnimationFrame(() => {
    document.querySelector(`.issue-card[data-key="${CSS.escape(key)}"]`)?.focus();
  });
}

/**
 * What to tell the person, in their language.
 *
 * The server speaks in codes and English sentences meant for a developer
 * reading a log. Passing those straight through puts an English exception in
 * front of somebody who was dragging a card.
 */
function moveFailure(error) {
  const detail = error.payload?.error?.detail;
  if (error.status === 403) return "권한이 없습니다. 이 이동은 admin만 할 수 있습니다.";
  if (error.status === 412) return "다른 사람이 먼저 이 이슈를 바꿨습니다. 최신 상태로 다시 그렸습니다.";
  if (error.code === "E_NEIGHBOURS_MOVED") {
    return "그 사이 순서가 바뀌었습니다. 다시 그렸으니 한 번 더 시도해 주세요.";
  }
  if (error.code === "E_ISSUE_QUARANTINED") {
    return `이 이슈는 격리 상태입니다. ${error.payload?.path ?? ""} 파일을 고쳐야 변경할 수 있습니다.`;
  }
  if (error.code === "E_TRANSITION_NOT_ALLOWED" && Array.isArray(error.payload?.allowed)) {
    return `허용된 이동: ${error.payload.allowed.map((s) => STATUS_LABELS[s] || s).join(", ")}`;
  }
  if (error.status === 409) return detail || "지금은 이 이동을 할 수 없습니다.";
  if (error.status === 400) return detail || "이 이동은 전이표에 없습니다.";
  return "옮기지 못했습니다.";
}

/** Says it out loud for a screen reader, and shows it for everyone else. */
function announce(message, isError = false) {
  $("#board-live").textContent = message;
  const existing = document.querySelector(".board-toast");
  if (existing) existing.remove();
  const toast = element("div", `board-toast${isError ? " error" : ""}`, message);
  document.body.append(toast);
  setTimeout(() => toast.remove(), isError ? 6000 : 2600);
}

/** The neighbours a drop lands between, as the rank API wants them. */
function neighboursAt(columnIssues, index, movingKey) {
  const rest = columnIssues.filter((issue) => issue.key !== movingKey);
  return {
    after: index > 0 ? rest[index - 1]?.uid ?? null : null,
    before: index < rest.length ? rest[index]?.uid ?? null : null,
  };
}

async function switchView(view) {
  if (state.view === view) return;
  state.view = view;
  $("#view-board").setAttribute("aria-selected", String(view === "board"));
  $("#view-backlog").setAttribute("aria-selected", String(view === "backlog"));
  await refreshIssues();
}

/**
 * The board: one sprint's scope, not the whole project.
 *
 * A column holding every issue that ever existed answers a different question
 * from "what are we doing now". The backlog view is the other question, and it
 * is a separate tab rather than a filter so neither pretends to be the other.
 */
async function loadBoard() {
  const project = $("#project-filter").value || state.issues[0]?.project;
  if (!project) {
    state.board = null;
    return;
  }
  try {
    state.board = await api(`/projects/${encodeURIComponent(project)}/board`);
  } catch (error) {
    if (error.status === 401) return void showLogin();
    state.board = null;
  }
}

function renderSprintLine() {
  const existing = $("#sprint-line");
  if (existing) existing.remove();
  if (state.view !== "board" || !state.board?.sprint) return;

  const { sprint, plan } = state.board;
  const line = element("p", "sprint-line");
  line.id = "sprint-line";
  const label = element("strong", "", sprint.name || sprint.id);
  line.append(label);
  if (sprint.goal) line.append(document.createTextNode(` — ${sprint.goal}`));

  if (plan) {
    const total = plan.capacity === null
      ? `${plan.committed} 포인트`
      : `${plan.committed} / ${plan.capacity} 포인트`;
    line.append(document.createTextNode(` · ${total}`));
    // Advisory, never a block (PRD R6). Said plainly so nobody reads it as a
    // failure to start.
    if (plan.over > 0) {
      line.append(element("span", "sprint-over", ` · capacity 초과 +${plan.over}`));
    }
    if (plan.unestimated > 0) {
      line.append(document.createTextNode(` · 무추정 ${plan.unestimated}건`));
    }
  }
  $("#board").before(line);
}

function renderColumn(status, issues) {
  const column = element("section", "column");
  const points = issues.reduce((total, issue) => total + (issue.points || 0), 0);
  const heading = element("div", "column-heading");
  const title = element("h2");
  title.append(element("span", `status-dot status-${status.toLowerCase()}`));
  title.append(document.createTextNode(STATUS_LABELS[status] || status));
  const count = element("span", "column-count", `${issues.length}`);
  heading.append(title, count, element("span", "column-points", `${points} pt`));
  column.append(heading);

  const cards = element("div", "cards");
  for (const issue of issues) cards.append(renderCard(issue));
  if (!issues.length) cards.append(element("p", "column-empty", "이슈 없음"));
  column.append(cards);

  // Only the board takes drops. The backlog tab is a different question and
  // dropping there would have to mean something this story has not defined.
  if (state.view === "board") makeDropTarget(column, cards, status, issues);
  return column;
}

function makeDropTarget(column, cards, status, issues) {
  column.addEventListener("dragover", (event) => {
    const dragged = state.dragging;
    if (!dragged) return;
    const from = dragged.status || "BACKLOG";
    const allowed = status === from || (dragged.allowed_to || []).includes(status);

    // The cursor says yes or no before the drop, using the table the server
    // sent. Letting a card be dropped somewhere it cannot go and bouncing it
    // back is a worse way to say the same thing.
    event.preventDefault();
    event.dataTransfer.dropEffect = allowed ? "move" : "none";
    column.classList.toggle("drop-ok", allowed);
    column.classList.toggle("drop-no", !allowed);
    if (allowed) showSlot(cards, event.clientY);
  });

  for (const type of ["dragleave", "drop"]) {
    column.addEventListener(type, () => {
      column.classList.remove("drop-ok", "drop-no");
      clearSlot();
    });
  }

  column.addEventListener("drop", async (event) => {
    event.preventDefault();
    const dragged = state.dragging;
    state.dragging = null;
    if (!dragged) return;

    const index = slotIndex(cards, event.clientY, dragged.key);
    await moveCard(dragged, status, neighboursAt(issues, index, dragged.key));
  });
}

/** Where a drop at this height would land, as an index into the column. */
function slotIndex(cards, clientY, movingKey) {
  const others = [...cards.querySelectorAll(".issue-card")].filter(
    (node) => node.dataset.key !== movingKey,
  );
  for (const [index, node] of others.entries()) {
    const box = node.getBoundingClientRect();
    if (clientY < box.top + box.height / 2) return index;
  }
  return others.length;
}

function showSlot(cards, clientY) {
  clearSlot();
  const slot = element("div", "card-slot");
  slot.id = "card-slot";
  const others = [...cards.querySelectorAll(".issue-card")];
  const at = slotIndex(cards, clientY, state.dragging?.key);
  if (at >= others.length) cards.append(slot);
  else others[at].before(slot);
}

function clearSlot() {
  document.querySelector("#card-slot")?.remove();
}

/**
 * What a run's badge says.
 *
 * `STALE` is reported beside RUNNING rather than instead of it: the claim is
 * still valid and the work may still be going, so replacing the state would
 * turn a warning into a verdict (ADR-004 §3).
 */
function runLabel(run) {
  if (run.state === "RUNNING") return run.stale ? "실행 중 · 응답 없음" : "실행 중";
  if (run.state === "DONE") return run.has_result ? "완료" : "완료 · 결과 미제출";
  if (run.state === "FAILED") return "실패";
  return "취소됨";
}

function runClass(run) {
  if (run.state === "RUNNING") return run.stale ? "stale" : "running";
  if (run.state === "DONE") return run.has_result ? "done" : "done-bare";
  return "stopped";
}

function renderCard(issue) {
  const card = element("article", "issue-card");
  const keyRow = element("div", "card-key-row");
  keyRow.append(element("span", "issue-key", issue.key));
  if (issue.type) keyRow.append(element("span", "issue-type", issue.type));
  card.append(keyRow, element("h3", "", issue.title || "제목 없음"));

  if (issue.labels?.length) {
    const labels = element("div", "labels");
    for (const label of issue.labels.slice(0, 3)) labels.append(element("span", "", label));
    card.append(labels);
  }

  const meta = element("div", "card-meta");
  meta.append(element("span", "assignee", issue.assignee ? initials(issue.assignee) : "–"));
  meta.append(element("span", "", issue.assignee || "담당자 없음"));
  if (issue.points != null) meta.append(element("strong", "", `${issue.points} pt`));

  // Who touched it last, not who made it. Without this an agent's change looks
  // exactly like the human creation it is sitting on top of (§5.1, §8).
  if (issue.last_actor_kind) meta.append(actorBadge(issue.last_actor_kind, "card-actor"));
  card.append(meta);

  // Blocked cards say so, and say by what — a mark alone sends the reader
  // hunting through the links panel for a reason the card already knows.
  if (issue.claimable === false && issue.blocked_by?.length) {
    const blocked = element("div", "card-meta");
    blocked.append(element("span", "card-blocked", `차단 ${issue.blocked_by.join(", ")}`));
    card.append(blocked);
  }
  // Who is on it now, and whether that session is still answering. S5 is about
  // spotting the stalled ones by eye, so this belongs on the card rather than
  // behind a click.
  if (issue.claim || issue.run) {
    const work = element("div", "card-meta card-run");
    if (issue.claim) {
      work.append(element("span", "card-claim", `선점 ${issue.claim.owner_id}`));
    }
    if (issue.run) {
      work.append(element("span", `card-run-state ${runClass(issue.run)}`, runLabel(issue.run)));
      // §6.2: delegated work shows both who ran it and who asked for it, or an
      // agent's action reads as the director's own.
      if (issue.run.initiated_by && issue.run.initiated_by !== issue.run.agent_id) {
        work.append(element("span", "card-run-by", `지시 ${issue.run.initiated_by}`));
      }
    }
    card.append(work);
  }

  if (issue.status === "BLOCKED" && issue.blocked_from) {
    const back = STATUS_LABELS[issue.blocked_from] || issue.blocked_from;
    // 으로/로 depends on whether the word ends in a consonant. Getting it wrong
    // reads as broken Korean in the one place the card is trying to be helpful.
    card.append(element("div", "card-from", `해제 시 ${back}${josaEuro(back)} 복귀`));
  }

  card.tabIndex = 0;
  card.dataset.key = issue.key;
  card.addEventListener("click", () => void openDetail(issue));

  if (state.view === "board") {
    card.draggable = true;
    card.setAttribute("aria-grabbed", "false");
    card.addEventListener("dragstart", (event) => {
      state.dragging = issue;
      card.classList.add("dragging");
      card.setAttribute("aria-grabbed", "true");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", issue.key);
    });
    card.addEventListener("dragend", () => {
      state.dragging = null;
      card.classList.remove("dragging");
      card.setAttribute("aria-grabbed", "false");
      clearSlot();
      document.querySelectorAll(".column").forEach((node) =>
        node.classList.remove("drop-ok", "drop-no"),
      );
    });
  }

  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      return void openDetail(issue);
    }
    // S2-D1: choosing a dependency-free stack means the keyboard path is ours
    // to write. A board only a mouse can operate is below the bar this project
    // set for itself in r14b.
    if (state.view === "board" && event.key.startsWith("Arrow")) {
      event.preventDefault();
      void moveByKeyboard(issue, event.key);
    }
  });
  return card;
}

/** Whether the last syllable ends in a consonant, which is what picks a particle. */
function endsInConsonant(word) {
  const last = word.charCodeAt(word.length - 1);
  if (last >= 0xac00 && last <= 0xd7a3) {
    const final = (last - 0xac00) % 28;
    return { closed: final !== 0, rieul: final === 8 };
  }
  // Issue keys end in a digit, and Korean reads them: 1 → 일, 2 → 이.
  const digit = "0123456789".indexOf(word[word.length - 1]);
  if (digit !== -1) {
    return { closed: [true, true, false, true, false, false, true, true, true, false][digit], rieul: false };
  }
  return { closed: false, rieul: false };
}

/** `으로` after a final consonant, `로` after a vowel or ㄹ. */
function josaEuro(word) {
  const { closed, rieul } = endsInConsonant(word);
  return !closed || rieul ? "로" : "으로";
}

/** `을` after a final consonant, `를` otherwise. */
function josaEul(word) {
  return endsInConsonant(word).closed ? "을" : "를";
}

const ACTOR_LABELS = { human: "사람", agent: "에이전트", external: "외부 편집", system: "시스템" };

/**
 * The actor badge.
 *
 * Colour *and* a word: the requirement is that an agent change never reads as a
 * human one, and colour alone fails that for a colour-blind reader or in a
 * greyscale screenshot pasted into a bug report.
 */
function actorBadge(kind, extra = "") {
  const known = ACTOR_LABELS[kind] ? kind : "system";
  return element("span", `kind kind-${known} ${extra}`.trim(), ACTOR_LABELS[kind] || kind);
}

async function openDetail(issue) {
  state.detail = { key: issue.key, cursor: null };
  $("#detail-key").textContent = issue.key;
  $("#detail-title").textContent = issue.title || "제목 없음";
  $("#timeline").replaceChildren();
  $("#detail").hidden = false;
  await loadCommits();
  await loadRuns();
  await loadActivity(false);
}

/**
 * Commits that named this issue in a trailer.
 *
 * Shown apart from a run's own `commits[]`: one is what history says happened,
 * the other is what an agent reported it did, and §5.7 is explicit that a commit
 * author is not an authenticated actor. Labelling the source is what keeps the
 * second from reading as the first.
 */
async function loadCommits() {
  const detail = state.detail;
  if (!detail) return;

  let payload;
  try {
    payload = await api(`/issues/${encodeURIComponent(detail.key)}/commits`);
  } catch {
    return;
  }

  const list = $("#commit-list");
  list.replaceChildren();
  $("#commits-empty").hidden = payload.commits.length > 0;

  for (const entry of payload.commits) {
    const item = element("li");
    const head = element("div", "entry-head");
    head.append(element("code", "commit-sha", entry.short));
    head.append(element("span", "entry-verb", entry.summary || "(제목 없음)"));
    head.append(element("span", "entry-at", entry.committed_at ? formatAt(entry.committed_at) : ""));
    item.append(head);

    const who = element("div", "entry-actor");
    who.append(actorBadge("system"));
    who.append(element("span", "", `${entry.author || "—"} · 트레일러 ${entry.trailer_key}`));
    item.append(who);
    list.append(item);
  }
}

/**
 * The runs on this issue, newest first, with the five fields opened out.
 *
 * Each field on its own line rather than one paragraph: the whole reason §6.2
 * asks for five is that a person reviewing the work can look at what was
 * verified without reading past a summary that says it went fine.
 */
async function loadRuns() {
  const detail = state.detail;
  if (!detail) return;

  let payload;
  try {
    payload = await api(`/runs?issue=${encodeURIComponent(detail.key)}`);
  } catch {
    return;
  }

  const list = $("#run-list");
  list.replaceChildren();
  $("#runs-empty").hidden = payload.runs.length > 0;

  for (const run of payload.runs) {
    const item = element("li");
    const head = element("div", "entry-head");
    head.append(element("span", `card-run-state ${runClass(run)}`, runLabel(run)));
    head.append(element("span", "entry-verb", run.agent_id || "에이전트"));
    head.append(element("span", "entry-at", run.started_at ? formatAt(run.started_at) : ""));
    item.append(head);

    // §6.2 delegation, and §8's rule that an agent's work must not read as a
    // person's: both names, every time.
    const who = element("div", "entry-actor");
    who.append(actorBadge("agent"));
    who.append(element("span", "", `지시 ${run.initiated_by || "—"} · 브랜치 ${run.branch || "—"}`));
    item.append(who);

    if (run.result) {
      item.append(resultBlock(run.result));
    } else if (run.state !== "RUNNING") {
      // Told apart from a finished report, or the runs worth looking at are
      // indistinguishable from the ones that went fine (AC10).
      item.append(element("div", "run-no-result", "결과 미제출로 종료됨"));
    }
    list.append(item);
  }
}

function resultBlock(result) {
  const box = element("div", "run-result");
  const row = (label, value) => {
    const line = element("div", "run-field");
    line.append(element("span", "run-field-label", label));
    line.append(element("span", "", value));
    box.append(line);
  };

  row("요약", result.summary || "—");
  const check = result.verification || {};
  const outcome = { passed: "통과", failed: "실패", skipped: "수행 안 함" }[check.outcome]
    || check.outcome || "—";
  row("검증", `${outcome} · ${check.method || "—"}`);
  row("변경 파일", result.files_changed?.length ? result.files_changed.join(", ") : "없음");
  row("커밋", result.commits?.length ? result.commits.join(", ") : "없음");
  row("잔여 위험", result.remaining_risks || "—");
  return box;
}

function closeDetail() {
  state.detail = null;
  $("#detail").hidden = true;
}

async function loadActivity(append) {
  const detail = state.detail;
  if (!detail) return;

  const query = detail.cursor ? `?before=${encodeURIComponent(detail.cursor)}` : "";
  let payload;
  try {
    payload = await api(`/issues/${encodeURIComponent(detail.key)}/activity${query}`);
  } catch (error) {
    if (error.status === 401) return void showLogin();
    return;
  }
  if (state.detail?.key !== detail.key) return;

  const list = $("#timeline");
  if (!append) list.replaceChildren();
  for (const entry of payload.entries) list.append(renderEntry(entry));

  $("#timeline-empty").hidden = payload.entries.length > 0 || append;
  $("#timeline-more").hidden = !payload.hasMore;
  state.detail.cursor = payload.nextBefore;
}

function renderEntry(entry) {
  const item = element("li");
  const head = element("div", "entry-head");
  head.append(element("span", "entry-verb", entry.verb));
  head.append(actorBadge(entry.actor.kind));
  head.append(element("span", "entry-at", formatAt(entry.at)));
  item.append(head);

  const who = entry.actor.id || (entry.actor.kind === "external" ? "unknown" : "—");
  const parts = [who];
  // Both subjects, never one: an agent acted, but a person told it to (§6.2).
  if (entry.actor.initiatedBy) parts.push(`지시: ${entry.actor.initiatedBy}`);
  if (entry.actor.runId) parts.push(`run: ${entry.actor.runId}`);
  item.append(element("div", "entry-actor", parts.join(" · ")));

  if (entry.before || entry.after) {
    const diff = element("div", "entry-diff");
    diff.textContent = `${format(entry.before)} → ${format(entry.after)}`;
    item.append(diff);
  }

  if (entry.sourceCommit) {
    // Deliberately hedged. A git author is not an authenticated actor, and
    // saying "so-and-so changed it" would put a guess into the record (§5.7).
    item.append(
      element("p", "entry-hint", `참고: 커밋 ${entry.sourceCommit.slice(0, 8)}에서 관측됨`),
    );
  }
  return item;
}

function format(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${entry === null ? "없음" : JSON.stringify(entry)}`)
      .join(", ");
  }
  return String(value);
}

function formatAt(at) {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleString();
}

/**
 * What a person can do about each kind of quarantine.
 *
 * Written here rather than taken from the server's message because the two say
 * different things on purpose: the server states what is wrong, this states
 * what to do. A person looking at a broken board needs the second one first.
 */
const RECOVERY = {
  conflict_marker: "충돌 표시(<<<<<<<, =======, >>>>>>>)를 지우고 한쪽 내용으로 정리한 뒤 저장하세요.",
  duplicate_uid: "같은 uid를 가진 파일 중 하나를 원본으로 두고, 나머지는 uid를 새로 발급하세요.",
  dangling_ref: "가리키는 대상이 없습니다. 참조를 지우거나 존재하는 이슈로 바꾸세요.",
  cycle: "부모 관계가 순환합니다. 고리 중 한 곳의 parent를 지우면 풀립니다.",
  yaml_error: "frontmatter YAML 문법이 깨졌습니다. 들여쓰기와 따옴표를 확인하세요.",
  yaml_unsupported: "이 도구가 지원하지 않는 YAML 문법입니다(앵커·별칭·태그 등). 값으로 풀어 쓰세요.",
  frontmatter_missing: "파일 맨 앞의 `---` 블록이 없습니다.",
  reserved_field: "예약된 필드 이름을 썼습니다. 다른 이름으로 바꾸세요.",
  encoding: "UTF-8로 읽을 수 없는 바이트가 있습니다.",
  schema_invalid: "YAML 문법은 맞지만 파일 구조가 맞지 않습니다. 필요한 항목이 빠졌는지 확인하세요.",
  json_error: "로그 파일의 한 줄이 JSON이 아닙니다. 오류 상세의 줄 번호를 보고 그 줄을 고치거나 지우세요.",
};

const REASON_LABELS = {
  conflict_marker: "머지 충돌 표시",
  duplicate_uid: "uid 중복",
  dangling_ref: "없는 참조",
  cycle: "계층 순환",
  yaml_error: "YAML 오류",
  yaml_unsupported: "미지원 YAML",
  frontmatter_missing: "frontmatter 없음",
  reserved_field: "예약어 사용",
  encoding: "인코딩 오류",
  schema_invalid: "구조 오류",
  json_error: "JSON 줄 오류",
};

const GIT_KIND_LABELS = { added: "추가", modified: "수정", deleted: "삭제", renamed: "이름변경" };

/**
 * The board worktree's git state.
 *
 * Read and shown, never acted on: D4 says the service does not commit or push,
 * so there is deliberately no button here that would. A person does that in a
 * terminal, and the badge exists so they remember to.
 */
async function refreshGit() {
  let status;
  try {
    status = await api("/git/status");
  } catch {
    return;
  }
  state.git = status;

  const badge = $("#git-badge");
  badge.hidden = false;
  badge.className = "git-badge";
  // Cleared, not appended to: this runs on every reconcile, and without it the
  // badge accumulates every reading it has ever taken.
  badge.replaceChildren();

  if (!status.available) {
    // A git failure must not look like a board failure. The issues are files
    // and they are fine; only the reporting is out.
    badge.classList.add("unavailable");
    badge.textContent = "git 상태 확인 불가";
    badge.title = [status.reason, status.recovery].filter(Boolean).join("\n");
    return;
  }

  const count = status.pending.length;
  const ahead = status.ahead ?? 0;
  badge.append(element("span", "count", String(count)));
  badge.append(document.createTextNode(" 미커밋"));

  // Committed is not backed up (D5). Someone who commits and sees zero would
  // otherwise believe their work is safe on a machine that is the only copy.
  if (ahead > 0) {
    badge.append(document.createTextNode(` · ${ahead} 미푸시`));
  }
  badge.append(element("span", "git-key", status.remote === null ? "원격 없음" : lastPushLabel(status)));

  if (count === 0 && ahead === 0) badge.classList.add("clean");
  else if (count >= 20 || ahead >= 10) badge.classList.add("stale");
  else if (count > 0 || ahead > 0) badge.classList.add("warn");
}

function lastPushLabel(status) {
  if (!status.lastPushAt) return "푸시 기록 없음";
  const at = new Date(status.lastPushAt);
  if (Number.isNaN(at.getTime())) return "푸시 기록 없음";
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (days >= 1) return `${days}일 전 푸시`;
  return `${at.toLocaleTimeString()} 푸시`;
}

function toggleGitPanel() {
  const panel = $("#git-panel");
  const opening = panel.hidden;
  panel.hidden = !opening;
  $("#git-badge").setAttribute("aria-expanded", String(opening));
  if (!opening) return;

  const status = state.git;
  const list = $("#git-list");
  list.replaceChildren();
  $("#git-panel-title").textContent = status?.available
    ? `미커밋 변경 ${status.pending.length}건${status.ahead ? ` · 미푸시 커밋 ${status.ahead}건` : ""}`
    : "git 상태 확인 불가";

  if (!status?.available) {
    list.append(element("p", "git-note", [status?.reason, status?.recovery].filter(Boolean).join(" ")));
    return;
  }
  if (status.pending.length === 0) {
    list.append(element("p", "git-note", "커밋할 변경이 없습니다."));
  }

  for (const file of status.pending) {
    const row = element("div", "git-file");
    row.append(element("span", `git-kind ${file.kind}`, GIT_KIND_LABELS[file.kind] || file.kind));
    row.append(element("span", "git-path", file.path));
    // The display key, so a path reads as an issue rather than a filename.
    if (file.key) row.append(element("span", "git-key", file.key));
    list.append(row);
  }
  list.append(
    element("p", "git-note", "커밋과 푸시는 터미널에서 직접 하세요. 이 도구는 파일만 씁니다."),
  );
}

async function refreshIntegrity() {
  let payload;
  try {
    payload = await api("/integrity/issues");
  } catch (error) {
    if (error.status === 401) return void showLogin();
    return;
  }

  const items = payload.quarantined || [];
  const conflicts = payload.sprintConflicts || [];
  const banner = $("#integrity-banner");

  // Nothing wrong means nothing shown. A banner that is always there is a
  // banner nobody reads.
  if (items.length === 0 && conflicts.length === 0) {
    banner.hidden = true;
    $("#integrity-panel").hidden = true;
    state.integrityOpen = false;
    banner.setAttribute("aria-expanded", "false");
    return;
  }

  const byReason = groupBy(items, (item) => item.reason);
  const summary = [...byReason.entries()]
    .map(([reason, group]) => `${REASON_LABELS[reason] || reason} ${group.length}건`)
    .join(" · ");

  banner.hidden = false;
  $("#integrity-summary").textContent = conflicts.length
    ? `격리 ${items.length}건 (${summary}) · 스프린트 충돌 ${conflicts.join(", ")} — 시작·종료 명령이 차단됩니다`
    : `격리 ${items.length}건 — ${summary}`;

  renderIntegrityGroups(byReason, conflicts);
}

function renderIntegrityGroups(byReason, conflicts) {
  const container = $("#integrity-groups");
  container.replaceChildren();

  if (conflicts.length) {
    const group = element("section", "integrity-group");
    group.append(element("h3", "", "스프린트 충돌"));
    const item = element("div", "integrity-item");
    item.append(element("div", "integrity-path", conflicts.join(", ")));
    item.append(
      element(
        "p",
        "integrity-fix",
        "ACTIVE 스프린트가 둘 이상입니다. 한쪽 파일의 status를 고쳐 하나만 남기면 시작·종료 명령이 다시 허용됩니다.",
      ),
    );
    group.append(item);
    container.append(group);
  }

  // Grouped by kind, because twenty entries of one type is one problem to fix
  // twenty times, and reading them as a flat list hides that.
  for (const [reason, items] of byReason) {
    const group = element("section", "integrity-group");
    group.append(element("h3", "", `${REASON_LABELS[reason] || reason} — ${items.length}건`));

    for (const item of items) {
      const row = element("div", "integrity-item");
      row.append(element("div", "integrity-path", item.path));
      if (item.detail) row.append(element("p", "integrity-detail", item.detail));
      const fix = RECOVERY[reason];
      if (fix) row.append(element("p", "integrity-fix", fix));
      row.append(element("p", "integrity-when", `발견: ${formatAt(item.detectedAt)}`));
      group.append(row);
    }
    container.append(group);
  }
}

function toggleIntegrity() {
  state.integrityOpen = !state.integrityOpen;
  $("#integrity-panel").hidden = !state.integrityOpen;
  $("#integrity-banner").setAttribute("aria-expanded", String(state.integrityOpen));
}

function groupBy(items, pick) {
  const groups = new Map();
  for (const item of items) {
    const key = pick(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

const COUNT_LABELS = {
  issues: "이슈", comments: "코멘트", sprints: "스프린트",
  runs: "run", events: "이벤트", projects: "프로젝트", files: "파일",
};

async function toggleSettings() {
  const view = $("#settings-view");
  view.hidden = !view.hidden;
  if (!view.hidden) await refreshIndexFacts();
}

async function refreshIndexFacts() {
  let payload;
  try {
    payload = await api("/index");
  } catch (error) {
    if (error.status === 401) return void showLogin();
    return;
  }

  const facts = $("#index-facts");
  facts.replaceChildren();
  const row = (label, value) => {
    facts.append(element("dt", "", label));
    facts.append(element("dd", "", value));
  };

  row("마지막 인덱싱", payload.lastRebuildAt ? formatAt(payload.lastRebuildAt) : "기록 없음");
  row("마지막 전체 검증", payload.lastVerifyAt ? formatAt(payload.lastVerifyAt) : "기록 없음");
  row(
    "인덱싱된 항목",
    Object.entries(payload.counts || {})
      .filter(([key]) => COUNT_LABELS[key])
      .map(([key, count]) => `${COUNT_LABELS[key]} ${count}`)
      .join(" · "),
  );
  row("격리", `${payload.quarantined}건`);
  if (payload.sprintConflicts?.length) row("스프린트 충돌", payload.sprintConflicts.join(", "));

  // A run already in flight has to be visible, or the only way to find out is
  // to press the button again (AC).
  setIndexBusy(payload.running);
  await refreshBurndown();
  await refreshTokens();
  await refreshRekeys();
}

/**
 * The burndown for whichever sprint is running.
 *
 * Two series, and never distinguished by colour alone (§8): the remaining line
 * is solid with round markers, the scope line is dashed with square ones, and
 * both are named in the summary above. A reader who cannot tell the two hues
 * apart still can tell the two lines apart.
 */
async function refreshBurndown() {
  let sprints;
  try {
    sprints = await api("/projects/LJ/sprints?status=ACTIVE");
  } catch {
    return;
  }

  const active = sprints.sprints?.[0];
  $("#burndown-empty").hidden = Boolean(active);
  $("#burndown").hidden = !active;
  if (!active) return;

  let chart;
  try {
    chart = await api(`/sprints/${encodeURIComponent(active.id)}/burndown`);
  } catch {
    return;
  }

  const current = chart.current;
  const done = current.done_points;
  const scope = current.scope_points;
  $("#burndown-summary").textContent =
    chart.completion === null
      ? `추정된 이슈가 없어 완료율을 계산하지 않습니다 · 무추정 ${current.unestimated}건`
      : `${done} / ${scope}점 완료 (${chart.completion}%) · ` +
        `남은 포인트는 실선, 스코프는 점선` +
        (current.unestimated ? ` · 무추정 ${current.unestimated}건` : "") +
        (current.cancelled ? ` · 취소 ${current.cancelled}건` : "");

  // Named rather than left to the eye: a number missing from a total has to be
  // visible as a number, not as a slightly lower line (AC23, §5.6).
  const notes = [];
  if (current.unestimated) notes.push(`무추정 ${current.unestimated}건은 분모에서 제외됩니다.`);
  if (current.cancelled) notes.push(`취소 ${current.cancelled}건은 분모에서 제외됩니다.`);
  if (chart.unindexed) {
    notes.push(`인덱싱하지 못한 파일 ${chart.unindexed}건이 집계에서 빠져 있습니다.`);
  }
  const note = $("#burndown-note");
  note.textContent = notes.join(" ");
  note.hidden = notes.length === 0;

  drawBurndown($("#burndown-chart"), chart.snapshots);
}

/** An SVG line chart, built by hand because the stack has no dependencies (S2-D1). */
function drawBurndown(host, snapshots) {
  host.replaceChildren();
  if (!snapshots.length) return;

  const W = 640;
  const H = 220;
  const pad = { top: 16, right: 16, bottom: 34, left: 44 };
  const top = Math.max(1, ...snapshots.map((s) => s.scope_points));
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  // One column per sample, evenly spaced. The x axis is the samples we have,
  // not a calendar — S4-D8 keeps days nobody measured out of the data, and
  // spacing them as if they existed would put them back in (S4-D8).
  const x = (i) =>
    pad.left + (snapshots.length === 1 ? plotW / 2 : (i * plotW) / (snapshots.length - 1));
  const y = (v) => pad.top + plotH - (v / top) * plotH;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "burndown-svg");
  svg.setAttribute("aria-label", burndownAlt(snapshots));

  const add = (tag, attrs) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    svg.append(node);
    return node;
  };

  for (let step = 0; step <= 2; step += 1) {
    const value = (top / 2) * step;
    add("line", {
      x1: pad.left, x2: W - pad.right, y1: y(value), y2: y(value), class: "burndown-grid",
    });
    const label = add("text", { x: pad.left - 8, y: y(value) + 4, class: "burndown-tick" });
    label.textContent = String(Math.round(value));
  }

  const line = (key, className) =>
    add("polyline", {
      points: snapshots.map((s, i) => `${x(i)},${y(s[key])}`).join(" "),
      class: className,
    });

  line("scope_points", "burndown-scope");
  line("done_points", "burndown-done");

  snapshots.forEach((s, i) => {
    // Square for scope, circle for remaining: the second signal, so the two
    // series survive a reader who cannot separate the colours.
    add("rect", {
      x: x(i) - 3, y: y(s.scope_points) - 3, width: 6, height: 6, class: "burndown-scope-dot",
    });
    add("circle", { cx: x(i), cy: y(s.done_points), r: 3.5, class: "burndown-done-dot" });
  });

  const first = add("text", { x: pad.left, y: H - 12, class: "burndown-tick" });
  first.textContent = snapshots[0].date;
  if (snapshots.length > 1) {
    const last = add("text", {
      x: W - pad.right, y: H - 12, class: "burndown-tick", "text-anchor": "end",
    });
    last.textContent = snapshots[snapshots.length - 1].date;
  }

  host.append(svg);
}

/** What a screen reader gets instead of the picture. */
function burndownAlt(snapshots) {
  const last = snapshots[snapshots.length - 1];
  return (
    `번다운 차트. 표본 ${snapshots.length}개, ${snapshots[0].date}부터 ${last.date}까지. ` +
    `현재 스코프 ${last.scope_points}점, 완료 ${last.done_points}점.`
  );
}

/**
 * The PAT list.
 *
 * `last_used_at` is a column here rather than a detail because S3-D7 allows
 * tokens that never expire — when expiry does not retire anything, the last
 * use is the only way an abandoned credential becomes visible.
 */
async function refreshTokens() {
  let payload;
  try {
    payload = await api("/tokens");
  } catch {
    return;
  }

  const list = $("#token-list");
  list.replaceChildren();
  $("#token-empty").hidden = payload.tokens.length > 0;

  for (const token of payload.tokens) {
    const item = element("li");
    const head = element("div", "entry-head");
    head.append(element("span", "entry-verb", token.name || "이름 없음"));
    if (token.revoked_at) head.append(element("span", "token-revoked", "폐기됨"));
    head.append(element("span", "entry-at", `${token.user} · ${token.token_id}`));
    item.append(head);

    const facts = element("div", "entry-actor");
    facts.append(
      element("span", "", `scope ${token.scopes.length ? token.scopes.join(" · ") : "없음"}`),
    );
    facts.append(element("span", "token-sep", " | "));
    // Never an empty cell: an unlimited token has to read as a decision
    // somebody made, not as a date that failed to render (S3-D7).
    facts.append(
      token.expires_at
        ? element("span", "", `만료 ${formatAt(token.expires_at)}`)
        : element("span", "token-forever", "만료 무기한"),
    );
    facts.append(element("span", "token-sep", " | "));
    facts.append(
      element(
        "span",
        token.last_used_at ? "" : "token-unused",
        token.last_used_at ? `최근 사용 ${formatAt(token.last_used_at)}` : "사용된 적 없음",
      ),
    );
    if (token.project_scope) {
      facts.append(element("span", "token-sep", " | "));
      facts.append(element("span", "", `프로젝트 ${token.project_scope}`));
    }
    item.append(facts);

    if (!token.revoked_at) {
      const revoke = element("button", "token-revoke", "폐기");
      revoke.type = "button";
      revoke.addEventListener("click", () => revokeToken(token));
      item.append(revoke);
    }
    list.append(item);
  }
}

async function issueToken(event) {
  event.preventDefault();
  const name = $("#token-name").value.trim();
  const days = $("#token-expiry").value;

  let issued;
  try {
    issued = await api("/tokens", {
      method: "POST",
      body: {
        ...(name ? { name } : {}),
        // "" is the unlimited option, and null is how the API spells it. Not
        // sending the field would mean "use the default" instead (S3-D7).
        expires_in_days: days === "" ? null : Number(days),
      },
    });
  } catch (error) {
    return void announce(`토큰을 발급하지 못했습니다: ${error.message}`);
  }

  const box = $("#token-secret");
  box.replaceChildren();
  box.append(element("strong", "", "이 값은 다시 볼 수 없습니다. 지금 복사하세요."));
  box.append(element("code", "token-value", issued.token));
  box.hidden = false;
  $("#token-name").value = "";
  announce(`토큰${josaEul("토큰")} 발급했습니다. 값은 이 화면에서만 볼 수 있습니다.`);
  await refreshTokens();
}

async function revokeToken(token) {
  const label = token.name || token.token_id;
  if (!confirm(`토큰 "${label}"${josaEul(label)} 폐기합니다. 이 토큰을 쓰는 에이전트는 즉시 끊깁니다.`)) {
    return;
  }
  try {
    await api(`/tokens/${encodeURIComponent(token.token_id)}`, { method: "DELETE" });
  } catch (error) {
    return void announce(`폐기하지 못했습니다: ${error.message}`);
  }
  announce(`토큰${josaEul("토큰")} 폐기했습니다.`);
  await refreshTokens();
}

async function refreshRekeys() {
  let payload;
  try {
    payload = await api("/rekeys");
  } catch {
    return;
  }

  const list = $("#rekey-list");
  list.replaceChildren();
  $("#rekey-empty").hidden = payload.rekeys.length > 0;

  for (const entry of payload.rekeys) {
    const item = element("li");
    const head = element("div", "entry-head");
    head.append(element("span", "entry-verb", `${entry.from} → ${entry.to}`));
    head.append(actorBadge("system"));
    head.append(element("span", "entry-at", formatAt(entry.at)));
    item.append(head);
    // The reason matters: a person seeing their key change wants to know it
    // was a collision and not somebody editing their issue.
    item.append(element("div", "entry-actor", `${entry.uid} · 사유: ${entry.reason || "—"}`));
    list.append(item);
  }
}

function setIndexBusy(running) {
  const progress = $("#index-progress");
  $("#index-verify").disabled = Boolean(running);
  $("#index-rebuild").disabled = Boolean(running);
  progress.hidden = !running;
  if (running) {
    progress.textContent =
      running === "rebuild" ? "전체 재인덱스 실행 중… 쓰기 요청은 대기합니다." : "전체 검증 실행 중…";
  }
}

async function runIndexOp(kind) {
  setIndexBusy(kind);
  $("#index-result").hidden = true;

  try {
    const payload = await api(`/index/${kind}`, { method: "POST" });
    const result = $("#index-result");
    result.textContent =
      kind === "rebuild"
        ? `재인덱스 완료 — ${payload.durationMs}ms, 결과가 이전과 ${payload.unchanged ? "동일합니다" : "다릅니다"}.`
        : `검증 완료 — ${payload.durationMs}ms, 신규 격리 ${payload.newlyQuarantined}건 · 해소 ${payload.released}건.`;
    result.hidden = false;
  } catch (error) {
    const result = $("#index-result");
    result.textContent =
      error.status === 403
        ? "권한이 없습니다. 전체 재인덱스는 admin만 실행할 수 있습니다."
        : error.message || "실행하지 못했습니다.";
    result.hidden = false;
  } finally {
    setIndexBusy(null);
    await refreshIndexFacts();
    await refreshIssues();
    await refreshIntegrity();
  }
}

function connectEvents() {
  state.source?.close();
  setLiveStatus("connecting", "연결 중");
  const source = new EventSource("/stream");
  state.source = source;
  source.onopen = () => setLiveStatus("live", "실시간");
  source.onerror = () => void handleStreamError(source);
  for (const event of ["issue.changed", "index.state", "integrity.changed", "resync"]) {
    source.addEventListener(event, () => {
      void refreshIssues();
      // The banner has to clear itself when somebody repairs a file, without
      // them going looking for a reload button (AC).
      void refreshIntegrity();
      // The same triggers r08c already watches for — HEAD and index move on a
      // commit — so the badge follows without a poll of its own.
      void refreshGit();
      // An external edit has to reach an open timeline without a reload (AC3).
      if (state.detail) {
        state.detail.cursor = null;
        void loadActivity(false);
      }
    });
  }
}

async function handleStreamError(source) {
  if (state.source !== source) return;
  setLiveStatus("offline", "재연결 중");
  try {
    await api("/me");
  } catch (error) {
    if (error.status === 401 && state.source === source) {
      source.close();
      state.source = null;
      showLogin("세션이 만료되었습니다. 다시 로그인해 주세요.");
    }
  }
}

function setLiveStatus(mode, label) {
  const status = $("#live-status");
  status.className = `live-status ${mode}`;
  status.lastChild.textContent = ` ${label}`;
}

async function api(path, options = {}) {
  const { ifMatch, body: payload, ...rest } = options;
  const response = await fetch(path, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(ifMatch ? { "if-match": ifMatch } : {}),
      ...options.headers,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(body.error?.message || `요청 실패 (${response.status})`);
    error.status = response.status;
    error.code = body.error?.code;
    // The whole body, because a refusal often carries the useful part: the
    // allowed transitions, the current order, the file to repair.
    error.payload = body;
    throw error;
  }

  // Carried out of band so a caller can send it straight back as If-Match
  // without a second request to fetch it.
  const etag = response.headers.get("etag");
  if (etag && typeof body === "object" && body !== null) {
    Object.defineProperty(body, "__etag", { value: etag, enumerable: false });
  }
  return body;
}

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function initials(value) {
  return value.slice(0, 2).toUpperCase();
}
