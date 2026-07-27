/**
 * A deliberately small YAML reader (design §3.2).
 *
 * Only the YAML 1.2 core schema subset the board format uses is accepted:
 * mappings, sequences, strings, integers, booleans and null. Anchors, aliases,
 * merge keys, explicit tags and duplicate keys are parse errors rather than
 * best-effort interpretations, because the parsed result feeds the ETag — two
 * implementations must agree byte for byte, and the ambiguous corners of YAML
 * are exactly where they would not.
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | YamlMapping;

export interface YamlMapping {
  [key: string]: YamlValue;
}

export type YamlErrorReason =
  | "tab_indent"
  | "anchor_or_alias"
  | "merge_key"
  | "explicit_tag"
  | "duplicate_key"
  | "bad_indent"
  | "unterminated_quote"
  | "bad_escape"
  | "flow_error"
  | "expected_mapping"
  | "unexpected";

export class YamlSubsetError extends Error {
  readonly reason: YamlErrorReason;
  readonly line: number;

  constructor(reason: YamlErrorReason, line: number, detail: string) {
    super(`${detail} (line ${line})`);
    this.name = "YamlSubsetError";
    this.reason = reason;
    this.line = line;
  }
}

interface Line {
  number: number;
  indent: number;
  content: string;
}

export function parseYamlSubset(source: string): YamlMapping {
  const lines = readLines(source);
  if (lines.length === 0) {
    return {};
  }

  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next < lines.length) {
    throw new YamlSubsetError(
      "bad_indent",
      lines[next].number,
      "Unexpected content after the document body",
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new YamlSubsetError(
      "expected_mapping",
      lines[0].number,
      "The document must be a mapping",
    );
  }
  return value;
}

function readLines(source: string): Line[] {
  const lines: Line[] = [];

  source.split(/\r\n|\r|\n/).forEach((raw, index) => {
    const number = index + 1;
    const withoutComment = stripComment(raw, number);
    if (withoutComment.trim() === "") {
      return;
    }
    if (/^[ ]*\t/.test(withoutComment)) {
      throw new YamlSubsetError(
        "tab_indent",
        number,
        "Tabs may not be used for indentation",
      );
    }

    const indent = withoutComment.length - withoutComment.trimStart().length;
    lines.push({ number, indent, content: withoutComment.trim() });
  });

  return lines;
}

/** A `#` only starts a comment at the start of a line or after whitespace. */
function stripComment(raw: string, line: number): string {
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (quote) {
      if (quote === '"' && char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(raw[index - 1]))) {
      return raw.slice(0, index);
    }
  }

  if (quote) {
    throw new YamlSubsetError("unterminated_quote", line, "Unterminated quote");
  }
  return raw;
}

function parseBlock(
  lines: Line[],
  start: number,
  indent: number,
): [YamlValue, number] {
  if (start >= lines.length || lines[start].indent < indent) {
    return [null, start];
  }
  if (lines[start].indent > indent) {
    throw new YamlSubsetError(
      "bad_indent",
      lines[start].number,
      "Unexpected indentation",
    );
  }
  return isSequenceItem(lines[start].content)
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent);
}

function isSequenceItem(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

function parseMapping(
  lines: Line[],
  start: number,
  indent: number,
): [YamlMapping, number] {
  const mapping: YamlMapping = {};
  let index = start;

  while (index < lines.length && lines[index].indent === indent) {
    const line = lines[index];
    if (isSequenceItem(line.content)) {
      break;
    }

    const { key, rest } = splitKey(line);
    if (key === "<<") {
      throw new YamlSubsetError(
        "merge_key",
        line.number,
        "Merge keys are not supported",
      );
    }
    if (Object.prototype.hasOwnProperty.call(mapping, key)) {
      throw new YamlSubsetError(
        "duplicate_key",
        line.number,
        `Duplicate key "${key}"`,
      );
    }

    if (rest === "") {
      const [child, next] = parseChildBlock(lines, index + 1, indent, line);
      mapping[key] = child;
      index = next;
    } else {
      mapping[key] = parseScalarOrFlow(rest, line.number);
      index += 1;
    }
  }

  return [mapping, index];
}

function parseSequence(
  lines: Line[],
  start: number,
  indent: number,
): [YamlValue[], number] {
  const items: YamlValue[] = [];
  let index = start;

  while (
    index < lines.length &&
    lines[index].indent === indent &&
    isSequenceItem(lines[index].content)
  ) {
    const line = lines[index];
    const rest = line.content === "-" ? "" : line.content.slice(2).trim();

    if (rest === "") {
      const [child, next] = parseChildBlock(lines, index + 1, indent, line);
      items.push(child);
      index = next;
      continue;
    }

    // A flow collection is a complete value, so it must be recognised before
    // the block-mapping check — `- {kind: x}` would otherwise split at the
    // first ": " and yield a key of "{kind".
    if (rest.startsWith("[") || rest.startsWith("{")) {
      items.push(parseScalarOrFlow(rest, line.number));
      index += 1;
      continue;
    }

    // `- key: value` starts a mapping that owns the following deeper lines.
    if (isMappingStart(rest, line.number)) {
      const itemIndent = indent + 2;
      const virtual: Line[] = [
        { number: line.number, indent: itemIndent, content: rest },
      ];
      let scan = index + 1;
      while (scan < lines.length && lines[scan].indent > indent) {
        virtual.push(lines[scan]);
        scan += 1;
      }
      const [mapping] = parseMapping(normalise(virtual, itemIndent), 0, itemIndent);
      items.push(mapping);
      index = scan;
      continue;
    }

    items.push(parseScalarOrFlow(rest, line.number));
    index += 1;
  }

  return [items, index];
}

/**
 * Lines that follow a `- key: value` item may be indented to align with the
 * key rather than to a fixed step, so they are re-based onto the item indent.
 */
function normalise(lines: Line[], itemIndent: number): Line[] {
  if (lines.length < 2) {
    return lines;
  }
  const observed = Math.min(...lines.slice(1).map((line) => line.indent));
  const delta = itemIndent - observed;
  return lines.map((line, position) =>
    position === 0 ? line : { ...line, indent: line.indent + delta },
  );
}

function parseChildBlock(
  lines: Line[],
  start: number,
  indent: number,
  parent: Line,
): [YamlValue, number] {
  if (start >= lines.length || lines[start].indent <= indent) {
    // `key:` with nothing under it is an explicit null, distinct from absence.
    return [null, start];
  }
  const childIndent = lines[start].indent;
  if (childIndent <= indent) {
    throw new YamlSubsetError(
      "bad_indent",
      parent.number,
      "Nested block must be indented further",
    );
  }
  return parseBlock(lines, start, childIndent);
}

function splitKey(line: Line): { key: string; rest: string } {
  const content = line.content;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (quote === '"' && char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ":" && (index + 1 === content.length || content[index + 1] === " ")) {
      const rawKey = content.slice(0, index).trim();
      return {
        key: decodeKey(rawKey, line.number),
        rest: content.slice(index + 1).trim(),
      };
    }
  }

  throw new YamlSubsetError(
    "unexpected",
    line.number,
    `Expected "key: value" but found ${JSON.stringify(content)}`,
  );
}

function isMappingStart(rest: string, line: number): boolean {
  try {
    splitKey({ number: line, indent: 0, content: rest });
    return true;
  } catch {
    return false;
  }
}

function decodeKey(raw: string, line: number): string {
  rejectNodeProperties(raw, line);
  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1)
  ) {
    return parseQuoted(raw, line);
  }
  return raw;
}

function parseScalarOrFlow(raw: string, line: number): YamlValue {
  rejectNodeProperties(raw, line);

  if (raw.startsWith("[") || raw.startsWith("{")) {
    const { value, end } = parseFlow(raw, 0, line);
    if (raw.slice(end).trim() !== "") {
      throw new YamlSubsetError(
        "flow_error",
        line,
        "Trailing content after a flow collection",
      );
    }
    return value;
  }
  return parseScalar(raw, line);
}

function rejectNodeProperties(raw: string, line: number): void {
  if (/^[&*]/.test(raw)) {
    throw new YamlSubsetError(
      "anchor_or_alias",
      line,
      "Anchors and aliases are not supported",
    );
  }
  if (/^!/.test(raw)) {
    throw new YamlSubsetError(
      "explicit_tag",
      line,
      "Explicit tags are not supported",
    );
  }
}

function parseScalar(raw: string, line: number): YamlValue {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    return parseQuoted(raw, line);
  }

  if (raw === "" || raw === "~" || raw === "null") {
    return null;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  // Integers only. A float or a version-like token stays a string so that no
  // value is silently reformatted on the way to the ETag.
  if (/^-?(0|[1-9]\d*)$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  return raw;
}

function parseQuoted(raw: string, line: number): string {
  const quote = raw[0];
  if (raw.length < 2 || raw[raw.length - 1] !== quote) {
    throw new YamlSubsetError("unterminated_quote", line, "Unterminated quote");
  }
  const body = raw.slice(1, -1);

  if (quote === "'") {
    return body.replace(/''/g, "'");
  }

  let out = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = body[index + 1];
    index += 1;
    switch (next) {
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "/": out += "/"; break;
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "0": out += "\0"; break;
      case "u": {
        const hex = body.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new YamlSubsetError("bad_escape", line, "Bad \\u escape");
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      default:
        throw new YamlSubsetError(
          "bad_escape",
          line,
          `Unsupported escape \\${next ?? ""}`,
        );
    }
  }
  return out;
}

interface FlowResult {
  value: YamlValue;
  end: number;
}

function parseFlow(raw: string, start: number, line: number): FlowResult {
  const open = raw[start];
  if (open === "[") {
    return parseFlowSequence(raw, start, line);
  }
  if (open === "{") {
    return parseFlowMapping(raw, start, line);
  }
  throw new YamlSubsetError("flow_error", line, "Expected a flow collection");
}

function parseFlowSequence(raw: string, start: number, line: number): FlowResult {
  const items: YamlValue[] = [];
  let index = start + 1;

  for (;;) {
    index = skipSpace(raw, index);
    if (index >= raw.length) {
      throw new YamlSubsetError("flow_error", line, "Unterminated flow sequence");
    }
    if (raw[index] === "]") {
      return { value: items, end: index + 1 };
    }

    const entry = readFlowValue(raw, index, line);
    items.push(entry.value);
    index = skipSpace(raw, entry.end);

    if (raw[index] === ",") {
      index += 1;
      continue;
    }
    if (raw[index] === "]") {
      return { value: items, end: index + 1 };
    }
    throw new YamlSubsetError("flow_error", line, "Expected , or ] in flow sequence");
  }
}

function parseFlowMapping(raw: string, start: number, line: number): FlowResult {
  const mapping: YamlMapping = {};
  let index = start + 1;

  for (;;) {
    index = skipSpace(raw, index);
    if (index >= raw.length) {
      throw new YamlSubsetError("flow_error", line, "Unterminated flow mapping");
    }
    if (raw[index] === "}") {
      return { value: mapping, end: index + 1 };
    }

    const keyToken = readFlowToken(raw, index, line, ":,}");
    const key = decodeKey(keyToken.text.trim(), line);
    if (key === "<<") {
      throw new YamlSubsetError("merge_key", line, "Merge keys are not supported");
    }
    if (Object.prototype.hasOwnProperty.call(mapping, key)) {
      throw new YamlSubsetError("duplicate_key", line, `Duplicate key "${key}"`);
    }

    index = skipSpace(raw, keyToken.end);
    if (raw[index] !== ":") {
      throw new YamlSubsetError("flow_error", line, "Expected : in flow mapping");
    }

    const entry = readFlowValue(raw, skipSpace(raw, index + 1), line);
    mapping[key] = entry.value;
    index = skipSpace(raw, entry.end);

    if (raw[index] === ",") {
      index += 1;
      continue;
    }
    if (raw[index] === "}") {
      return { value: mapping, end: index + 1 };
    }
    throw new YamlSubsetError("flow_error", line, "Expected , or } in flow mapping");
  }
}

function readFlowValue(raw: string, start: number, line: number): FlowResult {
  const char = raw[start];
  if (char === "[" || char === "{") {
    return parseFlow(raw, start, line);
  }
  const token = readFlowToken(raw, start, line, ",]}");
  return { value: parseScalar(token.text.trim(), line), end: token.end };
}

function readFlowToken(
  raw: string,
  start: number,
  line: number,
  terminators: string,
): { text: string; end: number } {
  let index = start;
  let quote: '"' | "'" | null = null;

  while (index < raw.length) {
    const char = raw[index];
    if (quote) {
      if (quote === '"' && char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (terminators.includes(char)) {
      break;
    }
    index += 1;
  }

  if (quote) {
    throw new YamlSubsetError("unterminated_quote", line, "Unterminated quote");
  }
  return { text: raw.slice(start, index), end: index };
}

function skipSpace(raw: string, index: number): number {
  let next = index;
  while (next < raw.length && /\s/.test(raw[next])) {
    next += 1;
  }
  return next;
}
