/**
 * Index schema (jira-docs/3_designs/database/index-schema.md).
 *
 * Two rules from that document shape almost every table here:
 *
 *  1. No domain invariant is enforced with UNIQUE. A merge can produce two
 *     issues with the same key or uid, and the index has to be able to *hold*
 *     that so §3.6 can quarantine or §3.8 can rekey it. Rejecting the second
 *     row at insert time would make the broken state unrepresentable, and
 *     which row survived would depend on scan order.
 *  2. References that a merge can legitimately break — parent, sprint, link
 *     targets — carry no foreign key. Storing the dangling reference *is* the
 *     job. Only syntactic constraints are enforced, with CHECK.
 *
 * Bumping SCHEMA_VERSION discards the index and rebuilds from files. That is
 * always safe: nothing here is a source of truth.
 */
export const SCHEMA_VERSION = 1;

export const INDEX_SCHEMA = `
CREATE TABLE file_state (
  path              TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN
                      ('config','users','project','issue','comment','comment_ops',
                       'sprint','run','proposal','event')),
  uid               TEXT,
  project           TEXT,
  mtime_ms          INTEGER NOT NULL,
  size              INTEGER NOT NULL,
  file_hash         TEXT NOT NULL,
  jsonl_offset      INTEGER,
  jsonl_prefix_hash TEXT,
  indexed_at        INTEGER NOT NULL
);
CREATE INDEX ix_file_state_uid  ON file_state(uid);
CREATE INDEX ix_file_state_kind ON file_state(kind);

CREATE TABLE issues (
  path            TEXT PRIMARY KEY,
  uid             TEXT NOT NULL,
  project         TEXT NOT NULL,
  key             TEXT NOT NULL,
  type            TEXT,
  title           TEXT,
  status          TEXT,
  blocked_from    TEXT,
  parent_uid      TEXT,
  sprint_id       TEXT,
  assignee_id     TEXT,
  points          INTEGER,
  backlog_rank    TEXT,
  board_rank      TEXT,
  created_by_kind TEXT,
  last_actor_kind TEXT,
  proposal_id     TEXT,
  created_at      TEXT,
  updated_at      TEXT,
  resource_json   TEXT NOT NULL,
  etag            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'OK'
                    CHECK (state IN ('OK','INVALID','PENDING_DELETE')),
  delete_deadline_at INTEGER
);
CREATE INDEX ix_issues_uid     ON issues(uid);
CREATE INDEX ix_issues_key     ON issues(project, key);
CREATE INDEX ix_issues_board   ON issues(sprint_id, status, board_rank, uid) WHERE state='OK';
CREATE INDEX ix_issues_backlog ON issues(project, backlog_rank, uid)         WHERE state='OK';
CREATE INDEX ix_issues_filter  ON issues(project, status, type, assignee_id) WHERE state='OK';
CREATE INDEX ix_issues_parent  ON issues(parent_uid);

CREATE TABLE issue_former_keys (
  path        TEXT NOT NULL REFERENCES issues(path) ON DELETE CASCADE,
  uid         TEXT NOT NULL,
  project     TEXT NOT NULL,
  key         TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY (path, key)
);
CREATE INDEX ix_former_keys_lookup ON issue_former_keys(project, key);

CREATE TABLE issue_labels (
  path  TEXT NOT NULL REFERENCES issues(path) ON DELETE CASCADE,
  uid   TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (path, label)
);
CREATE INDEX ix_labels_by_label ON issue_labels(label, uid);

CREATE TABLE issue_links (
  path     TEXT NOT NULL REFERENCES issues(path) ON DELETE CASCADE,
  from_uid TEXT NOT NULL,
  to_uid   TEXT NOT NULL,
  kind     TEXT NOT NULL,
  PRIMARY KEY (path, to_uid, kind)
);
CREATE INDEX ix_links_from ON issue_links(from_uid, kind);
CREATE INDEX ix_links_to   ON issue_links(to_uid, kind);

CREATE TABLE issue_acceptance (
  path  TEXT NOT NULL REFERENCES issues(path) ON DELETE CASCADE,
  uid   TEXT NOT NULL,
  ac_id TEXT NOT NULL,
  seq   INTEGER NOT NULL,
  text  TEXT,
  done  INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  PRIMARY KEY (path, ac_id)
);

CREATE TABLE projects (
  key             TEXT PRIMARY KEY,
  name            TEXT,
  timezone        TEXT,
  estimation_unit TEXT,
  resource_json   TEXT NOT NULL,
  etag            TEXT NOT NULL,
  path            TEXT NOT NULL
);

CREATE TABLE board_config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT,
  role          TEXT,
  resource_json TEXT NOT NULL
);

CREATE TABLE sprints (
  id            TEXT PRIMARY KEY,
  project       TEXT NOT NULL,
  name          TEXT,
  goal          TEXT,
  status        TEXT,
  start_at      TEXT,
  end_at        TEXT,
  capacity      INTEGER,
  resource_json TEXT NOT NULL,
  etag          TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'OK',
  path          TEXT NOT NULL
);
CREATE INDEX ix_sprints_active ON sprints(project, status) WHERE state='OK';

CREATE TABLE comments (
  comment_id    TEXT PRIMARY KEY,
  issue_key     TEXT NOT NULL,
  author_id     TEXT,
  author_name   TEXT,
  actor_kind    TEXT,
  kind          TEXT,
  body          TEXT,
  resolved      INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
  deleted       INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  created_at    TEXT,
  ops_file_hash TEXT,
  ops_applied   INTEGER NOT NULL DEFAULT 0,
  body_path     TEXT NOT NULL,
  ops_path      TEXT
);
CREATE INDEX ix_comments_issue  ON comments(issue_key, created_at);
CREATE INDEX ix_comments_gating ON comments(issue_key)
  WHERE deleted=0 AND resolved=0 AND kind IN ('question','review_request');

CREATE TABLE runs (
  run_id            TEXT PRIMARY KEY,
  issue_uid         TEXT,
  agent_id          TEXT,
  initiated_by      TEXT,
  session_id        TEXT,
  branch            TEXT,
  state             TEXT,
  started_at        TEXT,
  last_heartbeat_at TEXT,
  ended_at          TEXT,
  result_json       TEXT,
  path              TEXT NOT NULL
);
CREATE INDEX ix_runs_issue ON runs(issue_uid, started_at DESC);

CREATE TABLE events (
  event_id    TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  actor_id    TEXT,
  actor_kind  TEXT,
  run_id      TEXT,
  target_kind TEXT,
  target_uid  TEXT,
  verb        TEXT,
  detail_json TEXT,
  source_path TEXT NOT NULL
);
CREATE INDEX ix_events_target ON events(target_uid, at DESC);
CREATE INDEX ix_events_at     ON events(at DESC);

CREATE TABLE index_errors (
  path           TEXT PRIMARY KEY,
  uid            TEXT,
  project        TEXT,
  stage          TEXT NOT NULL CHECK (stage IN ('A','B')),
  reason         TEXT NOT NULL,
  detail         TEXT,
  last_good_hash TEXT,
  detected_at    INTEGER NOT NULL
);
CREATE INDEX ix_index_errors_project ON index_errors(project);

CREATE TABLE index_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE VIRTUAL TABLE issues_fts USING fts5(
  uid UNINDEXED, title, body, key_alias,
  tokenize='unicode61 remove_diacritics 2'
);
`;
