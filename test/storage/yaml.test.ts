import assert from "node:assert/strict";
import test from "node:test";

import { parseYamlSubset, YamlSubsetError } from "../../src/storage/yaml.ts";

function reason(source: string): string {
  try {
    parseYamlSubset(source);
  } catch (error) {
    assert.ok(error instanceof YamlSubsetError, `expected YamlSubsetError, got ${error}`);
    return error.reason;
  }
  throw new Error("expected the parse to fail");
}

test("reads the issue frontmatter shape", () => {
  const parsed = parseYamlSubset(
    [
      "uid: 01J8XQ9F3M2K7B4N5P6Q7R8S9T",
      "key: LJ-12",
      "former_keys: []",
      "type: story",
      'title: "백로그 리스트 가상 스크롤"',
      "status: IN_PROGRESS",
      "parent: 01J8XQ000000000000000000AA",
      "points: 3",
      "labels: [web, perf]",
      "links:",
      "  - {kind: blocked_by, to: 01J8XP000000000000000000BB}",
      "acceptance:",
      "  - id: ac1",
      '    text: "5,000건 스크롤 시 프레임 드랍 없음"',
      "    done: false",
      "created_at: 2026-07-27T11:20:00+09:00",
      "schema_version: 1",
    ].join("\n"),
  );

  assert.equal(parsed.key, "LJ-12");
  assert.equal(parsed.title, "백로그 리스트 가상 스크롤");
  assert.equal(parsed.points, 3);
  assert.equal(parsed.schema_version, 1);
  assert.deepEqual(parsed.former_keys, []);
  assert.deepEqual(parsed.labels, ["web", "perf"]);
  assert.deepEqual(parsed.links, [
    { kind: "blocked_by", to: "01J8XP000000000000000000BB" },
  ]);
  assert.deepEqual(parsed.acceptance, [
    { id: "ac1", text: "5,000건 스크롤 시 프레임 드랍 없음", done: false },
  ]);
  // A timestamp stays a string: reformatting it would change the ETag for no
  // reason and lose the author's offset.
  assert.equal(parsed.created_at, "2026-07-27T11:20:00+09:00");
});

test("distinguishes null from an absent key", () => {
  const parsed = parseYamlSubset("a: null\nb: ~\nc:\nd: \"\"");

  assert.equal(parsed.a, null);
  assert.equal(parsed.b, null);
  assert.equal(parsed.c, null);
  assert.equal(parsed.d, "");
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "a"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "missing"), false);
});

test("resolves only the scalar types in the subset", () => {
  const parsed = parseYamlSubset(
    [
      "int: 42",
      "negative: -7",
      "zero: 0",
      "bool: true",
      "notBool: True",
      "float: 1.5",
      "version: 1.2.3",
      "leadingZero: 007",
      "big: 99999999999999999999",
      "text: plain words",
    ].join("\n"),
  );

  assert.equal(parsed.int, 42);
  assert.equal(parsed.negative, -7);
  assert.equal(parsed.zero, 0);
  assert.equal(parsed.bool, true);
  // Only the lowercase spellings are booleans; anything else is text.
  assert.equal(parsed.notBool, "True");
  // Floats are outside the subset, so they survive as strings rather than
  // being reformatted by a float round-trip.
  assert.equal(parsed.float, "1.5");
  assert.equal(parsed.version, "1.2.3");
  assert.equal(parsed.leadingZero, "007");
  assert.equal(parsed.big, "99999999999999999999");
  assert.equal(parsed.text, "plain words");
});

test("handles quoting, escapes and colons inside values", () => {
  const parsed = parseYamlSubset(
    [
      'a: "say \\"hi\\""',
      "b: 'it''s here'",
      'c: "a: b"',
      'd: "line\\nbreak"',
      'e: "\\u00e9"',
      "f: value # not a comment marker inside a word#hash",
    ].join("\n"),
  );

  assert.equal(parsed.a, 'say "hi"');
  assert.equal(parsed.b, "it's here");
  assert.equal(parsed.c, "a: b");
  assert.equal(parsed.d, "line\nbreak");
  assert.equal(parsed.e, "é");
  assert.equal(parsed.f, "value");
});

test("keeps a # that is not preceded by whitespace", () => {
  const parsed = parseYamlSubset("key: board#1\nother: 'a # b'");
  assert.equal(parsed.key, "board#1");
  assert.equal(parsed.other, "a # b");
});

test("reads nested mappings and block sequences", () => {
  const parsed = parseYamlSubset(
    [
      "outer:",
      "  inner:",
      "    deep: 1",
      "  list:",
      "    - one",
      "    - two",
      "items:",
      "  - name: first",
      "    value: 1",
      "  - name: second",
      "    value: 2",
    ].join("\n"),
  );

  assert.deepEqual(parsed.outer, {
    inner: { deep: 1 },
    list: ["one", "two"],
  });
  assert.deepEqual(parsed.items, [
    { name: "first", value: 1 },
    { name: "second", value: 2 },
  ]);
});

test("reads nested flow collections", () => {
  const parsed = parseYamlSubset(
    'a: [1, "two", {k: v}]\nb: {x: [1, 2], y: {z: null}}\nc: []\nd: {}',
  );

  assert.deepEqual(parsed.a, [1, "two", { k: "v" }]);
  assert.deepEqual(parsed.b, { x: [1, 2], y: { z: null } });
  assert.deepEqual(parsed.c, []);
  assert.deepEqual(parsed.d, {});
});

test("ignores comments and blank lines", () => {
  const parsed = parseYamlSubset(
    ["# leading comment", "", "a: 1   # trailing", "", "# another", "b: 2", ""].join("\n"),
  );
  assert.deepEqual(parsed, { a: 1, b: 2 });
});

test("rejects the ambiguous corners of YAML rather than guessing", () => {
  // Two parsers could disagree on any of these, and the ETag would diverge.
  assert.equal(reason("base: &anchor\n  a: 1"), "anchor_or_alias");
  assert.equal(reason("copy: *anchor"), "anchor_or_alias");
  assert.equal(reason("a: 1\n<<: {b: 2}"), "merge_key");
  assert.equal(reason("when: !!timestamp 2026-07-27"), "explicit_tag");
  assert.equal(reason("a: 1\na: 2"), "duplicate_key");
  assert.equal(reason("a: {k: 1, k: 2}"), "duplicate_key");
  assert.equal(reason("a: 1\n\tb: 2"), "tab_indent");
  assert.equal(reason('a: "unterminated'), "unterminated_quote");
  assert.equal(reason('a: "bad \\q escape"'), "bad_escape");
  assert.equal(reason("a: [1, 2"), "flow_error");
  assert.equal(reason("just a scalar"), "unexpected");
});

test("reports the line number of a failure", () => {
  try {
    parseYamlSubset("a: 1\nb: 2\na: 3");
    throw new Error("expected failure");
  } catch (error) {
    assert.ok(error instanceof YamlSubsetError);
    assert.equal(error.line, 3);
    assert.match(error.message, /line 3/);
  }
});

test("treats an empty document as an empty mapping", () => {
  assert.deepEqual(parseYamlSubset(""), {});
  assert.deepEqual(parseYamlSubset("# only a comment\n"), {});
});
