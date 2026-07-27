/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * The ETag is the SHA-256 of the bytes the API actually sends (design §3.2,
 * ADR-003), so serialisation must be reproducible to the byte. JCS is used
 * rather than a hand-rolled rule set because key ordering, number formatting
 * and escaping are already specified there.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

export function canonicalJson(value: JsonValue): string {
  return serialise(value);
}

function serialise(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serialiseNumber(value);
    case "string":
      return serialiseString(value);
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map(serialise).join(",")}]`;
  }

  // RFC 8785 sorts by the UTF-16 code units of the key, which is exactly what
  // a plain `<` comparison on JavaScript strings does.
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const members = keys.map(
    (key) => `${serialiseString(key)}:${serialise(value[key])}`,
  );
  return `{${members.join(",")}}`;
}

function serialiseNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError(
      `${value} cannot be represented in canonical JSON`,
    );
  }
  // ECMAScript Number::toString, which RFC 8785 adopts wholesale.
  return Object.is(value, -0) ? "0" : String(value);
}

const SHORT_ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

function serialiseString(value: string): string {
  let out = '"';

  for (const char of splitUtf16(value)) {
    const short = SHORT_ESCAPES[char];
    if (short) {
      out += short;
      continue;
    }
    const code = char.charCodeAt(0);
    // Only C0 controls are escaped; everything else, including non-ASCII, is
    // emitted literally. Escaping more would still be valid JSON but a
    // different byte sequence, and the ETag would stop matching.
    out += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }

  return `${out}"`;
}

/** Iterates UTF-16 code units so lone surrogates survive round-tripping. */
function splitUtf16(value: string): string[] {
  const units: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    units.push(value[index]);
  }
  return units;
}
