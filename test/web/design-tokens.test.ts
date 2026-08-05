import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The stylesheet may not name a colour.
 *
 * HPMS §1.2 — 토큰이 진실: a component says what a thing *is* (`--destructive`,
 * `--muted`) and the token block says what that looks like. The sheet had drifted
 * the other way: 116 distinct hex values, each with a hand-written dark-mode
 * twin, and one of the twins — the text colour — had simply never been written,
 * so dark panels carried near-black text for months before anyone measured it.
 *
 * A test rather than a convention, because the convention is what failed.
 */

const CSS = fileURLToPath(new URL("../../src/web/app.css", import.meta.url));

function stylesheet(): string {
  return fs.readFileSync(CSS, "utf8");
}

/** Strips comments, so prose about a colour is not mistaken for using one. */
function rules(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

test("no component names a colour of its own", () => {
  const found = rules(stylesheet()).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(
    [...new Set(found)],
    [],
    "colours belong in the token block, and components reference them by role",
  );
});

test("colour is always a token or a mix of tokens", () => {
  const offenders: string[] = [];
  for (const line of rules(stylesheet()).split("\n")) {
    // Declarations that paint something. `border` is included because a raw
    // border colour is as much a hard-coded colour as a background.
    const painted = /(^|[;{\s])(color|background|background-color|border-color|fill|stroke|outline-color)\s*:\s*([^;}]+)/g;
    for (const [, , property, value] of line.matchAll(painted)) {
      const literal = value.trim();
      const allowed =
        literal.includes("var(--") ||
        literal.includes("color-mix(") ||
        /^(inherit|transparent|none|currentColor|initial|unset)\b/i.test(literal);
      if (!allowed) {
        offenders.push(`${property}: ${literal}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "every painted value comes from a token");
});

/**
 * Cards are flat (§6.3).
 *
 * Stated as "these surfaces have no shadow" rather than "only these four may
 * have one" — a first attempt did the latter and failed on the focus ring and
 * the live-status dot, which use `box-shadow` to draw a *ring*, not a lift. The
 * rule is about card surfaces, so that is what this asks about.
 */
test("card surfaces are flat", () => {
  const text = rules(stylesheet());
  const surfaces = [
    ".issue-card", ".login-card", ".column", ".settings-view", ".comment",
    ".integrity-group", ".run-result", ".burndown-chart", ".delete-children",
  ];
  const lifted: string[] = [];
  for (const surface of surfaces) {
    // The rule body for this exact selector, if it has one.
    const rule = new RegExp(`(^|\\})[^{}]*\\${surface}\\s*\\{([^}]*)\\}`, "m").exec(text);
    if (rule && /box-shadow\s*:\s*(?!none)/.test(rule[2])) {
      lifted.push(surface);
    }
  }
  assert.deepEqual(lifted, [], "surfaces are told apart by border, not by shadow");
});

/**
 * And lift, where it is used, means "this floats above the page".
 */
test("only overlays are lifted", () => {
  const text = rules(stylesheet());
  const lifted = new Set<string>();
  for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    // A drop shadow has an offset or a blur; a ring is spread-only or inset.
    if (!/box-shadow\s*:\s*(?!none)/.test(body)) continue;
    const declared = /box-shadow\s*:\s*([^;}]+)/.exec(body)![1];
    const isRing = declared.includes("inset") || /^0\s+0\s+0\s/.test(declared.trim());
    if (!isRing) {
      lifted.add(selector.trim().split("\n").pop()!.trim());
    }
  }
  assert.deepEqual(
    [...lifted].sort(),
    [".board-toast", ".detail", ".palette"].sort(),
    "a new lifted thing needs a reason to float",
  );
});

test("focus rings are not shadows in disguise", () => {
  // `input:focus` uses a box-shadow as its ring, which is the one place the
  // shape is a ring rather than a lift. It is spelled with the ring token, so it
  // follows the theme and is checked here rather than exempted silently.
  const text = rules(stylesheet());
  assert.match(text, /input:focus[^}]*box-shadow:[^}]*var\(--ring\)/);
});

test("the dark theme is one block, not nineteen", () => {
  const blocks = stylesheet().match(/@media \(prefers-color-scheme: dark\)/g) ?? [];
  assert.equal(
    blocks.length,
    1,
    "a per-component dark override is how the text colour got forgotten in the first place",
  );
});

test("both themes define the same token set", () => {
  const text = stylesheet();
  const light = text.slice(text.indexOf(":root {"), text.indexOf("@media"));
  const dark = text.slice(text.indexOf("@media"));

  const names = (block: string): string[] =>
    [...new Set((block.match(/^\s*(--[\w-]+)\s*:/gm) ?? []).map((line) => line.trim().replace(":", "")))];

  const inLight = names(light);
  const inDark = names(dark);
  // Derived tokens (radius, and the on-* text colours that mix with
  // `--foreground`) need no dark twin: they follow whatever they are built from.
  const derived = (name: string): boolean => name.startsWith("--radius") || name.startsWith("--on-");
  const missing = inLight.filter((name) => !derived(name) && !inDark.includes(name));

  assert.deepEqual(missing, [], "a token defined in one theme and not the other is a colour that will not flip");
});
