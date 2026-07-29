import type { DatabaseSync } from "node:sqlite";

import { canonicalJson, type JsonValue } from "./jcs.ts";
import type { FileIdentity } from "./layout.ts";
import {
  parseMarkdownResource,
  parseYamlResource,
  ResourceParseError,
  type ParsedResource,
} from "./resource.ts";

/** Everything one file contributes to the index. */
export interface FileRecords {
  identity: FileIdentity;
  uid: string | null;
  apply(db: DatabaseSync): void;
}

type Row = Record<string, JsonValue>;

export function buildRecords(
  identity: FileIdentity,
  bytes: Buffer,
): FileRecords {
  switch (identity.kind) {
    case "issue":
      return issueRecords(identity, parseMarkdownResource(bytes));
    case "project":
      return projectRecords(identity, parseYamlResource(bytes));
    case "config":
      return configRecords(identity, parseYamlResource(bytes));
    case "users":
      return userRecords(identity, parseYamlResource(bytes));
    case "sprint":
      return sprintRecords(identity, parseYamlResource(bytes));
    case "comment":
      return commentRecords(identity, parseMarkdownResource(bytes));
    case "comment_ops":
      return commentOpRecords(identity, bytes);
    case "run":
      return runRecords(identity, bytes);
    case "event":
      return eventRecords(identity, bytes);
    case "proposal":
      return noRecords(identity);
  }
}

function noRecords(identity: FileIdentity): FileRecords {
  return { identity, uid: null, apply: () => {} };
}

function issueRecords(
  identity: FileIdentity,
  parsed: ParsedResource,
): FileRecords {
  const front = parsed.resource as Row;
  const uid = str(front.uid) ?? identity.owner ?? identity.path;
  const key = str(front.key) ?? identity.owner ?? "";
  const project = identity.project ?? "";

  return {
    identity,
    uid,
    apply(db) {
      db.prepare(
        `INSERT INTO issues(path, uid, project, key, type, title, status, blocked_from,
           parent_uid, sprint_id, assignee_id, points, backlog_rank, board_rank,
           created_by_kind, last_actor_kind, proposal_id, created_at, updated_at,
           resource_json, etag)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        identity.path, uid, project, key,
        str(front.type), str(front.title), str(front.status), str(front.blocked_from),
        str(front.parent), str(front.sprint), str(front.assignee), int(front.points),
        str(front.backlog_rank), str(front.board_rank),
        str(front.created_by_kind), str(front.last_actor_kind), str(front.proposal_id),
        str(front.created_at), str(front.updated_at),
        parsed.canonical, parsed.etag,
      );

      for (const label of list(front.labels)) {
        const value = str(label);
        if (value !== null) {
          db.prepare(
            "INSERT OR IGNORE INTO issue_labels(path, uid, label) VALUES(?,?,?)",
          ).run(identity.path, uid, value);
        }
      }

      for (const raw of list(front.links)) {
        const link = raw as Row;
        const to = str(link?.to);
        const kind = str(link?.kind);
        if (to && kind) {
          db.prepare(
            "INSERT OR IGNORE INTO issue_links(path, from_uid, to_uid, kind) VALUES(?,?,?,?)",
          ).run(identity.path, uid, to, kind);
        }
      }

      list(front.former_keys).forEach((raw) => {
        const former = str(raw);
        if (former) {
          db.prepare(
            "INSERT OR IGNORE INTO issue_former_keys(path, uid, project, key) VALUES(?,?,?,?)",
          ).run(identity.path, uid, project, former);
        }
      });

      list(front.acceptance).forEach((raw, seq) => {
        const item = raw as Row;
        const id = str(item?.id) ?? `ac${seq + 1}`;
        db.prepare(
          "INSERT OR IGNORE INTO issue_acceptance(path, uid, ac_id, seq, text, done) VALUES(?,?,?,?,?,?)",
        ).run(identity.path, uid, id, seq, str(item?.text), item?.done === true ? 1 : 0);
      });

      const aliases = [key, ...list(front.former_keys).map(str)].filter(Boolean);
      // Acceptance criteria are searchable too: they carry the words that
      // describe what the work actually is, and a title rarely repeats them.
      const acceptance = list(front.acceptance)
        .map((entry) => str((entry as Row)?.text))
        .filter(Boolean)
        .join(" ");
      db.prepare(
        "INSERT INTO issues_fts(uid, title, body, key_alias, acceptance) VALUES(?,?,?,?,?)",
      ).run(uid, str(front.title) ?? "", parsed.body ?? "", aliases.join(" "), acceptance);
    },
  };
}

function projectRecords(
  identity: FileIdentity,
  parsed: ParsedResource,
): FileRecords {
  const row = parsed.resource as Row;
  return {
    identity,
    uid: null,
    apply(db) {
      db.prepare(
        `INSERT INTO projects(key, name, timezone, estimation_unit, resource_json, etag, path)
         VALUES(?,?,?,?,?,?,?)`,
      ).run(
        str(row.key) ?? identity.owner ?? "",
        str(row.name), str(row.timezone), str(row.estimation_unit),
        parsed.canonical, parsed.etag, identity.path,
      );
    },
  };
}

function configRecords(
  identity: FileIdentity,
  parsed: ParsedResource,
): FileRecords {
  const row = parsed.resource as Row;
  return {
    identity,
    uid: null,
    apply(db) {
      for (const [key, value] of Object.entries(row)) {
        db.prepare(
          "INSERT INTO board_config(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        ).run(key, typeof value === "string" ? value : canonicalJson(value));
      }
    },
  };
}

/**
 * The whole user set, from the one file that holds it.
 *
 * Every other kind is one file per entity, so removing one is removing a file
 * and `clearFile` handles it. `users.yaml` is the exception: the set lives
 * inside a single file, so applying it has to *replace* the set rather than
 * merge into it. Merging is what let a user deleted from the file keep their
 * row — and with it their role, which is what decides permission.
 */
function userRecords(
  identity: FileIdentity,
  parsed: ParsedResource,
): FileRecords {
  const row = parsed.resource as Row;

  // Checked here, before `clearFile` runs, so a malformed file is quarantined
  // with the previous set intact. An absent or non-list `users` would otherwise
  // read as "no users" and empty the board of everyone who can sign in.
  if (!Array.isArray(row.users)) {
    throw new ResourceParseError(
      "schema_invalid",
      "users.yaml must have a `users:` list, even when it is empty.",
    );
  }

  return {
    identity,
    uid: null,
    apply(db) {
      for (const raw of list(row.users)) {
        const user = raw as Row;
        const id = str(user?.id);
        if (!id) {
          continue;
        }
        db.prepare(
          "INSERT OR REPLACE INTO users(id, display_name, role, resource_json) VALUES(?,?,?,?)",
        ).run(id, str(user?.display_name), str(user?.role), canonicalJson(raw));
      }
    },
  };
}

function sprintRecords(
  identity: FileIdentity,
  parsed: ParsedResource,
): FileRecords {
  const row = parsed.resource as Row;
  return {
    identity,
    uid: null,
    apply(db) {
      db.prepare(
        `INSERT INTO sprints(id, project, name, goal, status, start_at, end_at, capacity,
           resource_json, etag, path)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        str(row.id) ?? identity.owner ?? "",
        identity.project ?? "",
        str(row.name), str(row.goal), str(row.status),
        str(row.start_at), str(row.end_at), int(row.capacity),
        parsed.canonical, parsed.etag, identity.path,
      );
    },
  };
}

function commentRecords(
  identity: FileIdentity,
  parsed: ParsedResource,
): FileRecords {
  const row = parsed.resource as Row;
  const commentId = str(row.comment_id) ?? identity.owner ?? identity.path;
  const issueKey = identity.path.split("/")[1] ?? "";

  return {
    identity,
    uid: commentId,
    apply(db) {
      db.prepare(
        `INSERT INTO comments(comment_id, issue_key, author_id, author_name, actor_kind,
           kind, body, resolved, deleted, created_at, body_path)
         VALUES(?,?,?,?,?,?,?,0,0,?,?)`,
      ).run(
        commentId, issueKey,
        str(row.author_id), str(row.author_name), str(row.actor_kind),
        str(row.kind) ?? "general", parsed.body ?? "",
        str(row.created_at), identity.path,
      );
    },
  };
}

/**
 * Applies the op log over a comment.
 *
 * Ops are replayed in `op_id` order, and the *whole* file is replayed whenever
 * its hash changes. A high-water mark would be cheaper but wrong: a merge can
 * introduce an op whose id sorts below one already applied, and a mark would
 * skip it for good (design §3.3).
 */
function commentOpRecords(identity: FileIdentity, bytes: Buffer): FileRecords {
  const commentId = identity.owner ?? "";
  const ops = readJsonLines(bytes)
    .map((line) => line as Row)
    .sort((a, b) => String(a.op_id ?? "").localeCompare(String(b.op_id ?? "")));

  return {
    identity,
    uid: commentId,
    apply(db) {
      let resolved = 0;
      let deleted = 0;
      let body: string | null = null;

      for (const op of ops) {
        switch (str(op.op)) {
          case "resolve": resolved = 1; break;
          case "unresolve": resolved = 0; break;
          case "delete": deleted = 1; break;
          case "edit": body = str((op.payload as Row | undefined)?.body); break;
          default: break;
        }
      }

      db.prepare(
        `UPDATE comments
            SET resolved = ?, deleted = ?, body = COALESCE(?, body),
                ops_file_hash = ?, ops_applied = ?, ops_path = ?
          WHERE comment_id = ?`,
      ).run(resolved, deleted, body, null, ops.length, identity.path, commentId);
    },
  };
}

function runRecords(identity: FileIdentity, bytes: Buffer): FileRecords {
  const row = JSON.parse(bytes.toString("utf8")) as Row;
  const runId = str(row.run_id) ?? identity.owner ?? identity.path;

  return {
    identity,
    uid: runId,
    apply(db) {
      db.prepare(
        `INSERT INTO runs(run_id, issue_uid, agent_id, initiated_by, session_id, branch,
           state, started_at, last_heartbeat_at, ended_at, result_json, path)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        runId, str(row.issue_uid), str(row.agent_id), str(row.initiated_by),
        str(row.session_id), str(row.branch), str(row.state),
        str(row.started_at), str(row.last_heartbeat_at), str(row.ended_at),
        row.result === undefined ? null : canonicalJson(row.result),
        identity.path,
      );
    },
  };
}

/**
 * Event files are per-day and per-node, so several files hold slices of one
 * timeline. They are loaded independently and ordered by `at` at query time.
 */
function eventRecords(identity: FileIdentity, bytes: Buffer): FileRecords {
  const events = readJsonLines(bytes).map((line) => line as Row);

  return {
    identity,
    uid: null,
    apply(db) {
      for (const event of events) {
        const eventId = str(event.event_id);
        if (!eventId) {
          continue;
        }
        db.prepare(
          `INSERT OR REPLACE INTO events(event_id, at, actor_id, actor_kind, run_id,
             target_kind, target_uid, verb, initiated_by, before_json, after_json,
             detail_json, source_path)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          eventId, str(event.at) ?? "", str(event.actor_id), str(event.actor_kind),
          str(event.run_id), str(event.target_kind), str(event.target_uid),
          str(event.verb), str(event.initiated_by),
          event.before === undefined || event.before === null ? null : canonicalJson(event.before),
          event.after === undefined || event.after === null ? null : canonicalJson(event.after),
          event.detail === undefined ? null : canonicalJson(event.detail),
          identity.path,
        );
      }
    },
  };
}

/** Tolerates a trailing partial line: a crash mid-append leaves one behind. */
function readJsonLines(bytes: Buffer): JsonValue[] {
  const out: JsonValue[] = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed) as JsonValue);
    } catch {
      // Ignore: an unterminated final line is expected after a crash, and a
      // malformed line is caught by validation rather than aborting the scan.
    }
  }
  return out;
}

export function isParseError(error: unknown): error is ResourceParseError {
  return error instanceof ResourceParseError;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function list(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}
