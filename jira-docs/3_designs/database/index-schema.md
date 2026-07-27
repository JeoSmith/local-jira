---
title: "인덱스·저널 SQLite 스키마"
status: draft   # draft | review | approved | deprecated
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
version: v2 (codex 교차검증 반영)
related_design: ../detailed/storage-layer.design.md
---

# 인덱스·저널 SQLite 스키마

[저장 계층 설계](../detailed/storage-layer.design.md)가 참조하는 3개 DB의 스키마다.
셋 다 `.localjira/.local/` 아래에 있고 **git 추적 대상이 아니며** 성격이 서로 다르다.

| DB | 성격 | 유실 시 |
|---|---|---|
| `index.sqlite` | 파일에서 재생성 가능한 **파생 인덱스** | 전체 재빌드로 100% 복구 |
| `outbox.sqlite` | 미완료 쓰기 **저널** + 멱등성 키 | 진행 중이던 쓰기 1건 유실 가능(파일은 온전) |
| `runtime.sqlite` | claim/lease·SSE 버퍼 등 **런타임 상태** | 전량 회수 = 정상 동작 |

## 설계 원칙 두 가지

**① 파생 DB에 도메인 불변조건을 UNIQUE로 걸지 않는다.**
`UNIQUE(project, key)`를 걸면 중복 표시 키를 가진 두 파일 중 **하나가 삽입 단계에서 거부**되어
사라진다. 그러면 "양쪽을 보존한 뒤 재키잉/격리한다"는 §3.6·§3.8을 구현할 수 없고, 어느 쪽이
살아남는지가 삽입 순서에 좌우된다. **인덱스는 깨진 현실도 그대로 담아야 하며**, 위반은
`integrity_conflicts` 테이블로 표현한다.

**② 구문 제약은 CHECK로 강제하고, 깨질 수 있는 참조는 FK로 걸지 않는다.**
`status`·`type` 같은 열거값은 파서가 보장하므로 CHECK로 못박는다. 반면 `parent_uid`·`sprint_id`는
머지로 얼마든지 dangling이 될 수 있고 **그 상태를 담는 것이 인덱스의 일**이므로 FK를 걸지 않는다
(Stage B가 검출해 격리한다).

---

## 1. `index.sqlite`

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = OFF;        -- 파생물. fsync 비용을 낼 이유가 없다 (설계 §3.4)
PRAGMA foreign_keys = ON;

-- ── 파일 추적 (모든 SoT 파일 종류가 여기 등록된다, 설계 §3.3) ──
CREATE TABLE file_state (
  path            TEXT PRIMARY KEY,      -- .localjira 기준 상대 경로
  kind            TEXT NOT NULL CHECK (kind IN
                    ('issue','comment','comment_ops','sprint','run','proposal','event')),
  uid             TEXT,                  -- rename 판정의 identity (JSONL은 NULL)
  project         TEXT,
  mtime_ms        INTEGER NOT NULL,
  size            INTEGER NOT NULL,
  dev_inode       TEXT,                  -- 변경 힌트일 뿐 identity 아님
  file_hash       TEXT NOT NULL,         -- 원본 바이트 SHA-256 hex 64자 (≠ ETag, 설계 §3.2)
  jsonl_offset    INTEGER,               -- JSONL 증분 처리 워터마크
  indexed_at      INTEGER NOT NULL
);
CREATE INDEX ix_file_state_uid  ON file_state(uid);
CREATE INDEX ix_file_state_kind ON file_state(kind);

-- ── 이슈 ────────────────────────────────────────────────────
CREATE TABLE issues (
  uid             TEXT PRIMARY KEY,
  project         TEXT NOT NULL,
  key             TEXT NOT NULL,         -- ★UNIQUE 아님★ — 중복도 담아야 재키잉이 가능하다
  type            TEXT NOT NULL CHECK (type IN
                    ('epic','story','task','bug','spike','subtask')),
  title           TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                    ('BACKLOG','TODO','IN_PROGRESS','IN_REVIEW','DONE','BLOCKED','CANCELLED')),
  blocked_from    TEXT,                  -- BLOCKED 진입 전 상태 (PRD §5.2)
  parent_uid      TEXT,                  -- FK 없음 — dangling도 담는다
  sprint_id       TEXT,                  -- FK 없음 (동)
  assignee_id     TEXT,
  points          INTEGER CHECK (points IS NULL OR points >= 0),  -- NULL = 무추정
  backlog_rank    TEXT NOT NULL,         -- 정렬은 항상 (rank, uid)
  board_rank      TEXT,                  -- 정렬 영역 = (sprint_id, status)
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('human','agent')),
  last_actor_kind TEXT NOT NULL CHECK (last_actor_kind IN
                    ('human','agent','external','system')),
  proposal_id     TEXT,                  -- AI 유래 표시 (D13)
  created_at      TEXT NOT NULL,         -- RFC 3339
  updated_at      TEXT NOT NULL,
  etag            TEXT NOT NULL,         -- JCS 응답 바이트 SHA-256 hex 64자(HTTP 헤더에서는 "hex64")
  state           TEXT NOT NULL DEFAULT 'OK'
                    CHECK (state IN ('OK','INVALID','PENDING_DELETE')),
  delete_deadline_at INTEGER,            -- PENDING_DELETE 유예 만료 (설계 §3.5, 영속 필수)
  path            TEXT NOT NULL          -- ★CASCADE 없음★ — 조정기가 상태를 명시적으로 전이시킨다
);
CREATE INDEX ix_issues_key     ON issues(project, key);          -- 중복 탐지 + alias 조회
CREATE INDEX ix_issues_board   ON issues(sprint_id, status, board_rank, uid) WHERE state='OK';
CREATE INDEX ix_issues_backlog ON issues(project, backlog_rank, uid)         WHERE state='OK';
CREATE INDEX ix_issues_filter  ON issues(project, status, type, assignee_id) WHERE state='OK';
CREATE INDEX ix_issues_parent  ON issues(parent_uid);
CREATE INDEX ix_issues_sprint  ON issues(sprint_id) WHERE state='OK';
CREATE INDEX ix_issues_pending ON issues(delete_deadline_at) WHERE state='PENDING_DELETE';

-- 옛 표시 키 alias (D3). 같은 옛 키를 여럿이 가질 수 있으므로 key는 UNIQUE 아님
CREATE TABLE issue_former_keys (
  uid         TEXT NOT NULL REFERENCES issues(uid) ON DELETE CASCADE,
  project     TEXT NOT NULL,
  key         TEXT NOT NULL,
  released_at TEXT NOT NULL,             -- alias 다중 매치 시 최신 우선 정렬용
  PRIMARY KEY (uid, key)
);
CREATE INDEX ix_former_keys_lookup ON issue_former_keys(project, key, released_at DESC);

CREATE TABLE issue_labels (
  uid   TEXT NOT NULL REFERENCES issues(uid) ON DELETE CASCADE,
  label TEXT NOT NULL,
  PRIMARY KEY (uid, label)
);
-- label 선행 인덱스 — AC13의 "라벨로 먼저 좁히는" 필터 경로
CREATE INDEX ix_labels_by_label ON issue_labels(label, uid);

CREATE TABLE issue_links (
  from_uid TEXT NOT NULL REFERENCES issues(uid) ON DELETE CASCADE,
  to_uid   TEXT NOT NULL,                -- FK 없음 — dangling 링크도 담는다
  kind     TEXT NOT NULL CHECK (kind IN
             ('blocks','blocked_by','relates_to','duplicates')),
  PRIMARY KEY (from_uid, to_uid, kind)
);
CREATE INDEX ix_links_to ON issue_links(to_uid, kind);

CREATE TABLE issue_acceptance (
  uid   TEXT NOT NULL REFERENCES issues(uid) ON DELETE CASCADE,
  ac_id TEXT NOT NULL,
  seq   INTEGER NOT NULL,
  text  TEXT NOT NULL,
  done  INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  PRIMARY KEY (uid, ac_id)
);

-- ── 전문 검색 ────────────────────────────────────────────────
-- 일반(자체 저장) FTS5를 쓴다. contentless(content='')는 컬럼 조회가 NULL이고
-- 삭제·갱신에 특수 명령이 필요해 조정기 코드가 복잡해진다. 본문 중복 저장(~10MB)을
-- 감수하고 단순한 delete-then-insert 경로를 택한다. 토크나이저는 OQ1에서 확정.
CREATE VIRTUAL TABLE issues_fts USING fts5(
  uid UNINDEXED, title, body, key_alias,
  tokenize='unicode61 remove_diacritics 2'
);
-- 갱신 절차: DELETE FROM issues_fts WHERE uid=? → INSERT. 트리거를 쓰지 않는다
-- (조정기가 배치로 처리하며, 트리거는 재빌드 시 성능을 망친다).

-- ── 스프린트 ─────────────────────────────────────────────────
CREATE TABLE sprints (
  id           TEXT PRIMARY KEY,
  project      TEXT NOT NULL,
  name         TEXT NOT NULL,
  goal         TEXT,
  status       TEXT NOT NULL CHECK (status IN ('PLANNED','ACTIVE','CLOSED')),
  start_at     TEXT,                     -- RFC 3339 (+offset)
  end_at       TEXT,
  capacity     INTEGER CHECK (capacity IS NULL OR capacity >= 0),  -- 스토리 포인트 (D8)
  etag         TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'OK' CHECK (state IN ('OK','INVALID','PENDING_DELETE')),
  delete_deadline_at INTEGER,
  path         TEXT NOT NULL
);
-- ★ACTIVE 유일성을 UNIQUE로 걸지 않는다★ — 머지로 ACTIVE가 2개가 될 수 있고
-- 그 사실을 담아야 §3.6이 sprint_conflict로 격리할 수 있다.
CREATE INDEX ix_sprints_active ON sprints(project, status) WHERE state='OK';

-- 번다운 스냅샷 (D12) — 원본은 스프린트 파일. 여기는 조회용 사본
CREATE TABLE burndown_snapshots (
  sprint_id     TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  day           TEXT NOT NULL,           -- YYYY-MM-DD (프로젝트 timezone)
  scope_points  INTEGER NOT NULL,
  done_points   INTEGER NOT NULL,
  unestimated   INTEGER NOT NULL,        -- 분모 제외분. 별도 표기용
  PRIMARY KEY (sprint_id, day)
);

-- ── 코멘트 (원문 + op 재생 결과) ──────────────────────────────
CREATE TABLE comments (
  comment_id   TEXT PRIMARY KEY,         -- ULID
  issue_uid    TEXT NOT NULL,            -- FK 없음 — 고아 코멘트도 담는다
  author_id    TEXT NOT NULL,
  author_name  TEXT NOT NULL,            -- 작성 당시 표시명
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('human','agent','external','system')),
  kind         TEXT NOT NULL CHECK (kind IN
                 ('general','question','decision','review_request')),
  body         TEXT NOT NULL,            -- 최신 edit op 반영 결과
  resolved     INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
  deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  created_at   TEXT NOT NULL,
  last_op_id   TEXT,                     -- 재생 워터마크 (op_id 정렬 기준, 설계 §3.3)
  body_path    TEXT NOT NULL,            -- 원문 파일
  ops_path     TEXT                      -- op 파일 (없을 수 있음)
);
-- R19 게이팅: 미해결 question/review_request 존재 여부 조회 경로
CREATE INDEX ix_comments_gating ON comments(issue_uid)
  WHERE deleted=0 AND resolved=0 AND kind IN ('question','review_request');
CREATE INDEX ix_comments_issue ON comments(issue_uid, created_at);

-- ── 실행 로그 ────────────────────────────────────────────────
CREATE TABLE runs (
  run_id        TEXT PRIMARY KEY,
  issue_uid     TEXT,                    -- FK 없음
  agent_id      TEXT NOT NULL,
  initiated_by  TEXT,                    -- 지시한 사람 (대리 실행 표시)
  session_id    TEXT,
  branch        TEXT,
  state         TEXT NOT NULL,           -- 열거값은 r17a의 미정 항목. CHECK는 확정 후 추가
  started_at    TEXT NOT NULL,
  last_heartbeat_at TEXT,
  ended_at      TEXT,
  result_json   TEXT,                    -- 구조화 결과 5필드
  path          TEXT NOT NULL
);
CREATE INDEX ix_runs_issue ON runs(issue_uid, started_at DESC);

CREATE TABLE run_commits (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  sha    TEXT NOT NULL,
  PRIMARY KEY (run_id, sha)
);

-- R23 커밋 연결은 인덱스 전용 (D14). 유실되면 git 재스캔으로 복원
CREATE TABLE commit_links (
  sha        TEXT NOT NULL,
  issue_uid  TEXT NOT NULL,
  matched_by TEXT NOT NULL CHECK (matched_by IN ('current_key','former_key')),
  scanned_at INTEGER NOT NULL,
  PRIMARY KEY (sha, issue_uid)
);
-- alias 후보가 2건 이상이라 연결을 보류한 커밋 (설계 §3.8)
CREATE TABLE commit_link_ambiguous (
  sha        TEXT NOT NULL,
  key        TEXT NOT NULL,
  candidates TEXT NOT NULL,              -- JSON 배열
  PRIMARY KEY (sha, key)
);

-- ── 이벤트 (활동 타임라인 조회용 사본) ─────────────────────────
CREATE TABLE events (
  event_id    TEXT PRIMARY KEY,          -- ULID
  at          TEXT NOT NULL,
  actor_id    TEXT,
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('human','agent','external','system')),
  run_id      TEXT,
  target_kind TEXT NOT NULL,
  target_uid  TEXT,
  verb        TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX ix_events_target ON events(target_uid, at DESC);
CREATE INDEX ix_events_at     ON events(at DESC);

-- ── 무결성 (설계 §3.6) ───────────────────────────────────────
CREATE TABLE index_errors (
  path           TEXT PRIMARY KEY,       -- 파싱 실패는 uid를 모르므로 path가 키다
  uid            TEXT,                   -- 알 수 있으면 채운다
  project        TEXT,                   -- NULL이면 전역 배너 대상
  stage          TEXT NOT NULL CHECK (stage IN ('A','B')),
  reason         TEXT NOT NULL,
  detail         TEXT,
  last_good_hash TEXT,                   -- 마지막 정상 상태. 삭제하지 않고 보존
  detected_at    INTEGER NOT NULL
);
CREATE INDEX ix_index_errors_project ON index_errors(project);

-- UNIQUE 제약 대신 충돌을 데이터로 표현한다 (설계 원칙 ①)
CREATE TABLE integrity_conflicts (
  kind       TEXT NOT NULL CHECK (kind IN
               ('duplicate_key','duplicate_uid','sprint_active','cycle')),
  project    TEXT NOT NULL,
  subject    TEXT NOT NULL,              -- 중복된 key / uid / sprint project 등
  members    TEXT NOT NULL,              -- 관련 uid JSON 배열
  resolution TEXT,                       -- rekeyed | quarantined | NULL(미처리)
  detected_at INTEGER NOT NULL,
  PRIMARY KEY (kind, project, subject)
);

-- ── 메타 ────────────────────────────────────────────────────
CREATE TABLE index_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- schema_version, generation, last_full_reconcile_at, last_verify_at,
-- replayed_outbox_seq, node_id
```

---

## 2. `outbox.sqlite`

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = FULL;       -- 여기가 끊기면 복구 근거가 사라진다 (설계 §3.4)

CREATE TABLE outbox (
  op_id         TEXT PRIMARY KEY,        -- ULID
  seq           INTEGER NOT NULL,        -- 단조 증가. 재생 순서
  kind          TEXT NOT NULL CHECK (kind IN ('create','update','delete')),
  stage         TEXT NOT NULL CHECK (stage IN
                  ('PENDING','FILE_DONE','INDEX_DONE','EVENT_DONE','DONE','ABORTED')),
  target_path   TEXT NOT NULL,
  before_hash   TEXT,                    -- 쓰기 직전 file_hash (create면 NULL)
  result_hash   TEXT,                    -- 쓴 뒤 나와야 할 file_hash (delete면 NULL)
  payload       BLOB,                    -- 롤포워드용 최종 바이트 (delete면 NULL)
  event_payload TEXT,
  actor_id      TEXT,
  actor_kind    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  aborted_reason TEXT                    -- CAS 3분기의 세 번째 갈래 기록
);
CREATE INDEX ix_outbox_replay ON outbox(seq) WHERE stage NOT IN ('DONE','ABORTED');

-- R15 멱등성 — 같은 DB에 두어 재생·수명주기를 한 곳에서 관리
CREATE TABLE idempotency (
  actor_id     TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,            -- 같은 키·다른 페이로드 판별 (r15 미정 항목)
  status_code  INTEGER NOT NULL,
  response     TEXT NOT NULL,            -- 최초 응답 원문
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,         -- created_at + 24h
  PRIMARY KEY (actor_id, key)
);
CREATE INDEX ix_idem_expiry ON idempotency(expires_at);
```

- `stage`는 **각 단계 완료마다 durable하게 갱신**된다. 다만 JSONL append와 stage 갱신 사이의
  크래시 창은 남으므로, `EVENT_DONE` 이전 재생은 대상 이벤트 파일에서 `event_payload.event_id`
  존재 여부를 확인한다. 멱등성의 근거는 **stage + event_id 존재 확인**이다(설계 §3.4).
- `DONE`·`ABORTED`는 24시간 뒤 정리한다(멱등성 키와 보존 기간을 맞춘다).
- 기동 시 미완료를 `seq` 오름차순 재생하며, **재생 완료 전에는 도메인 쓰기 API를 수락하지 않는다**(503).

---

## 3. `runtime.sqlite`

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = OFF;        -- 재기동 시 만료분 전량 회수

CREATE TABLE claims (
  issue_uid         TEXT PRIMARY KEY,    -- PK가 곧 원자적 선점 장치
  owner_id          TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  acquired_at       INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  lease_expires_at  INTEGER NOT NULL     -- heartbeat 성공 시 +15분 갱신 (D10)
);
CREATE INDEX ix_claims_lease ON claims(lease_expires_at);

-- SSE 재생 버퍼 (설계 §3.9)
CREATE TABLE sse_epoch (epoch TEXT PRIMARY KEY);   -- DB 생성 시 1회 발급되는 ULID
CREATE TABLE sse_buffer (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload    TEXT NOT NULL
);
```

- `claims`의 PK가 `issue_uid`인 것이 **원자적 선점의 구현**이다. 두 에이전트가 동시에 `INSERT`하면 하나만 성공하고 나머지는 제약 위반 → 409.
  *(여기서는 UNIQUE를 쓴다. 런타임 상태는 파생 인덱스와 달리 "깨진 현실을 담을" 이유가 없고, 오히려 제약이 동시성 장치다.)*
- `STALE`은 저장하지 않는다. `now - last_heartbeat_at > 3분`으로 **조회 시점에 계산**한다(D10이 표시 상태와 점유권을 분리했으므로).
- **SSE 이벤트 ID = `{epoch}-{seq}`**. runtime DB가 재생성되면 `epoch`가 바뀌므로, 클라이언트의 옛 `Last-Event-ID`는 epoch 불일치로 즉시 `resync`된다. 버퍼는 최근 1,000건을 **append와 prune 한 트랜잭션**으로 유지하고 `min_seq`/`max_seq`를 함께 노출해 경계 누락을 검출한다.

---

## 4. 참고

- 설계 `../detailed/storage-layer.design.md` §3.2(두 해시)·§3.4(WriteTxn CAS)·§3.6(격리)·§3.7(세대 교체)·§3.8(재키잉)·§3.9(SSE)
- PRD `../../2_requirements/prd/backlog-sprint.md` §5 · §13
