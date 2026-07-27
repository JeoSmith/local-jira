import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson, CanonicalJsonError } from "../../src/storage/jcs.ts";
import {
  etagOf,
  fileHash,
  formatEtag,
  parseMarkdownResource,
  parseYamlResource,
  ResourceParseError,
} from "../../src/storage/resource.ts";

function issueFile(frontmatter: string, body = "설명 본문\n"): Buffer {
  return Buffer.from(`---\n${frontmatter}\n---\n${body}`, "utf8");
}

function reason(bytes: Buffer): string {
  try {
    parseMarkdownResource(bytes);
  } catch (error) {
    assert.ok(error instanceof ResourceParseError, `got ${error}`);
    return error.reason;
  }
  throw new Error("expected the parse to fail");
}

// ── RFC 8785 ────────────────────────────────────────────────────────────────

test("sorts object keys by UTF-16 code unit", () => {
  assert.equal(
    canonicalJson({ b: 1, a: 2, A: 3, "": 4, "\u00e9": 5, Z: 6 }),
    '{"":4,"A":3,"Z":6,"a":2,"b":1,"é":5}',
  );
});

test("emits no insignificant whitespace and preserves array order", () => {
  assert.equal(
    canonicalJson({ list: [3, 1, 2], nested: { x: null } }),
    '{"list":[3,1,2],"nested":{"x":null}}',
  );
});

test("escapes only what JSON requires", () => {
  assert.equal(canonicalJson('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(canonicalJson("tab\there\nnew"), '"tab\\there\\nnew"');
  assert.equal(canonicalJson("\u0001"), '"\\u0001"');
  // Non-ASCII stays literal: escaping it would be valid JSON but different
  // bytes, and the ETag would no longer match what was sent.
  assert.equal(canonicalJson("한글 é 🙂"), '"한글 é 🙂"');
});

test("formats numbers the way ECMAScript does", () => {
  assert.equal(canonicalJson(0), "0");
  assert.equal(canonicalJson(-0), "0");
  assert.equal(canonicalJson(-7), "-7");
  assert.equal(canonicalJson(1e21), "1e+21");
  assert.throws(() => canonicalJson(Number.NaN), CanonicalJsonError);
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), CanonicalJsonError);
});

// ── file → resource ─────────────────────────────────────────────────────────

test("folds the markdown body into the resource", () => {
  const parsed = parseMarkdownResource(issueFile("key: LJ-12\ntype: story"));

  assert.deepEqual(parsed.resource, {
    key: "LJ-12",
    type: "story",
    body: "설명 본문\n",
  });
  assert.equal(parsed.canonical, '{"body":"설명 본문\\n","key":"LJ-12","type":"story"}');
  assert.equal(parsed.etag, etagOf(parsed.canonical));
  assert.equal(parsed.etag.length, 64);
  assert.match(parsed.etag, /^[0-9a-f]{64}$/);
});

test("formats the wire ETag as a strong validator", () => {
  const etag = formatEtag("a".repeat(64));
  assert.equal(etag, `"${"a".repeat(64)}"`);
  assert.equal(etag.startsWith("W/"), false);
});

test("normalises line endings but nothing else in the body", () => {
  const crlf = parseMarkdownResource(
    Buffer.from("---\nkey: LJ-1\n---\nline one\r\nline two\r\n", "utf8"),
  );
  const lf = parseMarkdownResource(
    Buffer.from("---\nkey: LJ-1\n---\nline one\nline two\n", "utf8"),
  );

  // core.autocrlf must not produce a spurious 412.
  assert.equal(crlf.etag, lf.etag);
  assert.equal(crlf.body, "line one\nline two\n");
});

test("keeps trailing spaces, which are a markdown hard break", () => {
  const parsed = parseMarkdownResource(
    Buffer.from("---\nkey: LJ-1\n---\nbreak here  \nnext\n", "utf8"),
  );
  assert.equal(parsed.body, "break here  \nnext\n");
  assert.match(parsed.canonical, /break here  \\n/);
});

test("does not apply Unicode normalisation", () => {
  const nfc = parseMarkdownResource(issueFile("key: LJ-1", "쇼\n"));
  const nfd = parseMarkdownResource(issueFile("key: LJ-1", "쇼\n".normalize("NFD")));

  // Documented consequence (design OQ5): visually identical text on macOS and
  // Linux can carry different ETags. Asserted so the trade-off is not lost.
  assert.notEqual(nfc.etag, nfd.etag);
});

test("keeps unknown frontmatter keys in the representation", () => {
  const parsed = parseMarkdownResource(
    issueFile("key: LJ-1\nsomethingNew: kept\nnested:\n  also: kept"),
  );

  assert.equal((parsed.resource as Record<string, unknown>).somethingNew, "kept");
  assert.deepEqual((parsed.resource as Record<string, unknown>).nested, { also: "kept" });
});

test("gives the same ETag for files that differ only in formatting", () => {
  const a = parseMarkdownResource(issueFile("key: LJ-1\ntype: story\npoints: 3"));
  const b = parseMarkdownResource(issueFile("points: 3\ntype: story\nkey: LJ-1"));
  const c = parseMarkdownResource(issueFile('key: "LJ-1"\ntype: story\npoints: 3'));

  assert.equal(a.etag, b.etag, "key order is not part of the representation");
  assert.equal(a.etag, c.etag, "quoting style is not part of the representation");
});

test("gives a different ETag when the meaning changes", () => {
  const base = parseMarkdownResource(issueFile("key: LJ-1\nstatus: TODO"));
  const changed = parseMarkdownResource(issueFile("key: LJ-1\nstatus: DONE"));
  const bodyChanged = parseMarkdownResource(issueFile("key: LJ-1\nstatus: TODO", "다른 본문\n"));
  const nulled = parseMarkdownResource(issueFile("key: LJ-1\nstatus:"));

  assert.notEqual(base.etag, changed.etag);
  assert.notEqual(base.etag, bodyChanged.etag);
  assert.notEqual(base.etag, nulled.etag, "null must differ from a value");
});

test("separates the file hash from the ETag", () => {
  const crlf = Buffer.from("---\nkey: LJ-1\n---\nbody\r\n", "utf8");
  const lf = Buffer.from("---\nkey: LJ-1\n---\nbody\n", "utf8");

  // Same representation, different bytes: the ETag matches, the file hash does
  // not. That split is what lets the watcher see a change the API should not
  // report as a conflict (design §3.2).
  assert.equal(parseMarkdownResource(crlf).etag, parseMarkdownResource(lf).etag);
  assert.notEqual(fileHash(crlf), fileHash(lf));
  assert.equal(fileHash(lf), createHash("sha256").update(lf).digest("hex"));
});

test("reads a standalone YAML document", () => {
  const parsed = parseYamlResource(
    Buffer.from("schema_version: 1\nkey: LJ\nname: Local Jira\n", "utf8"),
  );

  assert.equal(parsed.body, null);
  assert.deepEqual(parsed.resource, { schema_version: 1, key: "LJ", name: "Local Jira" });
  assert.equal(parsed.canonical.includes('"body"'), false);
});

test("refuses files it cannot represent faithfully", () => {
  assert.equal(reason(Buffer.from("no frontmatter here\n", "utf8")), "frontmatter_missing");
  assert.equal(reason(issueFile("key: LJ-1\nkey: LJ-2")), "yaml_error");
  assert.equal(reason(issueFile("key: !!str LJ-1")), "yaml_unsupported");
  assert.equal(reason(issueFile("key: LJ-1\nbody: collides")), "reserved_field");
});

test("refuses a file left mid-merge by git", () => {
  const conflicted = Buffer.from(
    [
      "---",
      "key: LJ-1",
      "<<<<<<< HEAD",
      "status: TODO",
      "=======",
      "status: DONE",
      ">>>>>>> other",
      "---",
      "body\n",
    ].join("\n"),
    "utf8",
  );

  // Parsing on would index one side of an unresolved merge as if it were the
  // real state.
  assert.equal(reason(conflicted), "conflict_marker");
});

test("drops a byte order mark without treating it as content", () => {
  const withBom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("---\nkey: LJ-1\n---\nbody\n", "utf8"),
  ]);

  assert.equal(
    parseMarkdownResource(withBom).etag,
    parseMarkdownResource(Buffer.from("---\nkey: LJ-1\n---\nbody\n", "utf8")).etag,
  );
});

test("handles a file with frontmatter and no body", () => {
  const parsed = parseMarkdownResource(Buffer.from("---\nkey: LJ-1\n---\n", "utf8"));
  assert.equal(parsed.body, "");
  assert.deepEqual(parsed.resource, { key: "LJ-1", body: "" });
});
