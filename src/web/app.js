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

const state = { issues: [], user: null, source: null, detail: null, integrityOpen: false };
const $ = (selector) => document.querySelector(selector);

document.addEventListener("DOMContentLoaded", boot);
$("#login-form").addEventListener("submit", login);
$("#logout-button").addEventListener("click", logout);
$("#project-filter").addEventListener("change", renderBoard);
$("#detail-close").addEventListener("click", closeDetail);
$("#integrity-banner").addEventListener("click", toggleIntegrity);
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
    await refreshIntegrity();
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
};

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
