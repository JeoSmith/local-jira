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

const state = { issues: [], user: null, source: null, detail: null };
const $ = (selector) => document.querySelector(selector);

document.addEventListener("DOMContentLoaded", boot);
$("#login-form").addEventListener("submit", login);
$("#logout-button").addEventListener("click", logout);
$("#project-filter").addEventListener("change", renderBoard);
$("#detail-close").addEventListener("click", closeDetail);
$("#timeline-more").addEventListener("click", () => void loadActivity(true));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.detail) closeDetail();
});

async function boot() {
  try {
    const payload = await api("/me");
    showBoard(payload.user);
    await refreshIssues();
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
      body: JSON.stringify({ id: form.get("id"), password: form.get("password") }),
    });
    showBoard(payload.user);
    await refreshIssues();
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
  $("#board-empty").hidden = issues.length !== 0;
  board.hidden = issues.length === 0;

  const points = issues.reduce((total, issue) => total + (issue.points || 0), 0);
  $("#board-summary").textContent = `${issues.length}개 이슈 · ${points} 포인트`;

  const statuses = [...STATUS_ORDER];
  for (const status of new Set(issues.map((issue) => issue.status || "BACKLOG"))) {
    if (!statuses.includes(status)) statuses.push(status);
  }

  for (const status of statuses) {
    const columnIssues = issues.filter((issue) => (issue.status || "BACKLOG") === status);
    if (!columnIssues.length && ["BLOCKED", "CANCELLED"].includes(status)) continue;
    board.append(renderColumn(status, columnIssues));
  }
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
  return column;
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

  card.tabIndex = 0;
  card.addEventListener("click", () => void openDetail(issue));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void openDetail(issue);
    }
  });
  return card;
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
  await loadActivity(false);
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
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || `요청 실패 (${response.status})`);
    error.status = response.status;
    error.code = body.error?.code;
    throw error;
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
