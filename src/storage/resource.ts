import { createHash } from "node:crypto";

import { canonicalJson, type JsonValue } from "./jcs.ts";
import {
  parseYamlSubset,
  YamlSubsetError,
  type YamlMapping,
  type YamlValue,
} from "./yaml.ts";

/** The markdown body is carried in the resource under this reserved name. */
export const BODY_FIELD = "body";

export type ResourceErrorReason =
  | "encoding"
  | "frontmatter_missing"
  | "yaml_error"
  | "yaml_unsupported"
  | "reserved_field"
  | "conflict_marker"
  // A line in a .jsonl log that is not JSON. Told apart from `yaml_error`
  // because the file is not YAML and the repair is per line, not per document.
  | "json_error"
  // Valid YAML that is not the shape the file is supposed to hold. Separate
  // from `yaml_error` because the repair is different: the syntax is fine and
  // what needs fixing is the structure.
  | "schema_invalid";

export class ResourceParseError extends Error {
  readonly reason: ResourceErrorReason;
  readonly line: number | null;

  constructor(reason: ResourceErrorReason, message: string, line: number | null = null) {
    super(message);
    this.name = "ResourceParseError";
    this.reason = reason;
    this.line = line;
  }
}

export interface ParsedResource {
  /** Frontmatter as parsed, before the body is folded in. */
  frontmatter: YamlMapping;
  /** Markdown body with line endings normalised, `null` for YAML/JSON files. */
  body: string | null;
  /** The API representation: frontmatter plus `body`. */
  resource: JsonValue;
  /** RFC 8785 bytes of `resource` — what the API sends. */
  canonical: string;
  /** SHA-256 of `canonical`, lowercase hex. The strong ETag. */
  etag: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/;
const CONFLICT_MARKER = /^(<{7}|={7}|>{7})(?: |$)/m;

/** SHA-256 of the raw bytes. Drives watcher change detection and outbox CAS. */
export function fileHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function etagOf(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Formats an ETag for the wire. Always strong — never `W/`. */
export function formatEtag(etag: string): string {
  return `"${etag}"`;
}

/**
 * Reads a `---` frontmatter + markdown file into its API representation.
 *
 * The body is preserved byte for byte apart from line endings: trailing spaces
 * are a hard line break in markdown and Unicode is left un-normalised, so
 * neither may be "tidied" on the way through (design §3.2).
 */
export function parseMarkdownResource(bytes: Buffer): ParsedResource {
  const text = decodeUtf8(bytes);
  assertNoConflictMarker(text);

  const match = FRONTMATTER.exec(text);
  if (!match) {
    throw new ResourceParseError(
      "frontmatter_missing",
      "The file does not begin with a --- frontmatter block",
    );
  }

  const frontmatter = parseFrontmatter(match[1]);
  const body = normaliseNewlines(match[2] ?? "");

  if (Object.prototype.hasOwnProperty.call(frontmatter, BODY_FIELD)) {
    throw new ResourceParseError(
      "reserved_field",
      `"${BODY_FIELD}" is reserved for the markdown body and may not appear in frontmatter`,
    );
  }

  return finish(frontmatter, body);
}

/** Reads a standalone YAML document (config, project, sprint files). */
export function parseYamlResource(bytes: Buffer): ParsedResource {
  const text = decodeUtf8(bytes);
  assertNoConflictMarker(text);
  return finish(parseFrontmatter(text), null);
}

function finish(frontmatter: YamlMapping, body: string | null): ParsedResource {
  const resource = toJson(frontmatter) as { [key: string]: JsonValue };
  if (body !== null) {
    resource[BODY_FIELD] = body;
  }

  const canonical = canonicalJson(resource);
  return {
    frontmatter,
    body,
    resource,
    canonical,
    etag: etagOf(canonical),
  };
}

function parseFrontmatter(source: string): YamlMapping {
  try {
    return parseYamlSubset(source);
  } catch (error) {
    if (error instanceof YamlSubsetError) {
      throw new ResourceParseError(
        isUnsupported(error) ? "yaml_unsupported" : "yaml_error",
        error.message,
        error.line,
      );
    }
    throw error;
  }
}

function isUnsupported(error: YamlSubsetError): boolean {
  return (
    error.reason === "anchor_or_alias" ||
    error.reason === "merge_key" ||
    error.reason === "explicit_tag"
  );
}

/**
 * A conflict marker means git left the file mid-merge. Parsing on would either
 * fail confusingly or, worse, succeed on one side of the conflict and index a
 * half-merged issue as if it were real (design §3.6).
 */
function assertNoConflictMarker(text: string): void {
  const match = CONFLICT_MARKER.exec(text);
  if (match) {
    const line = text.slice(0, match.index).split("\n").length;
    throw new ResourceParseError(
      "conflict_marker",
      `The file contains an unresolved git conflict marker (${match[1]})`,
      line,
    );
  }
}

function decodeUtf8(bytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (text.includes("�") && !bytes.includes(0xef)) {
    throw new ResourceParseError("encoding", "The file is not valid UTF-8");
  }
  // A BOM is a byte-order artefact, not content.
  return text.startsWith("﻿") ? text.slice(1) : text;
}

function normaliseNewlines(body: string): string {
  return body.replace(/\r\n|\r/g, "\n");
}

function toJson(value: YamlValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJson);
  }
  const out: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value)) {
    out[key] = toJson(value[key]);
  }
  return out;
}
