import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The `.app` builder.
 *
 * The bundle itself can only be *launched* on a Mac with a browser installed,
 * so what is checked here is everything up to that: the shape of the bundle,
 * that the launcher was told the right board and port, and that the icon comes
 * out as an image rather than as nothing.
 *
 * That last one is not padding. The first draft drew the mark at fractional
 * coordinates, and a fractional index into a Buffer is not an error — the write
 * is dropped. The icon came out reading "L I" and nothing anywhere said so.
 */

import { iconPixels, ICON_INK } from "../../scripts/make-app.ts";

const SCRIPT = fileURLToPath(new URL("../../scripts/make-app.ts", import.meta.url));

function make(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

function sandbox(t: { after: (fn: () => void) => void }): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "localjira-app-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Only the marker the builder looks for; `init` is exercised elsewhere and a
  // whole board here would be slow for no extra signal.
  fs.mkdirSync(path.join(root, "board", ".localjira"), { recursive: true });
  return root;
}

/**
 * The window has to be the app's own.
 *
 * The first version opened a Chromium window in `--app` mode. It looked right
 * in Finder — the bundle's name and icon — and then you ran it and the Dock said
 * "Google Chrome". A shortcut that opens a browser is not what was asked for,
 * and nothing in the build said which one had been made.
 */
test("a machine with swiftc gets a native window, and the build says so", (t) => {
  const root = sandbox(t);
  const made = make(root, ["--repo", path.join(root, "board"), "--out", path.join(root, "out")]);
  assert.equal(made.status, 0, made.stderr);

  const macos = path.join(root, "out", "Local Jira.app", "Contents", "MacOS");
  const compiled = fs.existsSync(path.join(macos, "Local Jira"));
  // macOS *and* the compiler. Swift runs on Linux too — GitHub's Ubuntu runners
  // have it — but `Cocoa` and `WebKit` do not, so "swiftc exists" is not the
  // same question as "a native window can be built". This assertion said it was
  // and turned green on a Mac while failing in CI.
  const canBuildNative =
    process.platform === "darwin" &&
    spawnSync("swiftc", ["--version"], { encoding: "utf8" }).status === 0;

  assert.equal(compiled, canBuildNative, "native on macOS with swiftc, browser launcher elsewhere");
  // Whichever it built, it has to say which — the difference is visible to the
  // person the moment they launch it.
  assert.match(made.stdout, compiled ? /네이티브/ : /브라우저 앱 모드/);
  if (!compiled) {
    // And *why* — "swiftc가 없어" on a Mac without the tools is a different
    // thing to fix than "macOS가 아니라".
    assert.match(made.stdout, process.platform === "darwin" ? /swiftc/ : /macOS가 아니라/);
  }

  if (compiled) {
    // A shim that hands the binary its board, not the browser launcher.
    const shim = fs.readFileSync(path.join(macos, "launcher"), "utf8");
    assert.match(shim, /LJ_REPO=/);
    assert.match(shim, /exec /);
    assert.equal(/--app=/.test(shim), false, "the native path must not open a browser");
  }
});

test("the bundle has the pieces macOS needs to treat it as an app", (t) => {
  const root = sandbox(t);
  const made = make(root, ["--repo", path.join(root, "board"), "--out", path.join(root, "out")]);
  assert.equal(made.status, 0, made.stderr);

  const bundle = path.join(root, "out", "Local Jira.app");
  const plist = fs.readFileSync(path.join(bundle, "Contents", "Info.plist"), "utf8");
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>launcher<\/string>/);
  assert.match(plist, /<key>CFBundlePackageType<\/key><string>APPL<\/string>/);

  const launcher = path.join(bundle, "Contents", "MacOS", "launcher");
  assert.ok(fs.existsSync(launcher));
  // Without the executable bit macOS reports a damaged application rather than
  // anything that points at the cause.
  assert.equal((fs.statSync(launcher).mode & 0o111) !== 0, true, "launcher must be executable");
});

test("the launcher is told which board and which port", (t) => {
  const root = sandbox(t);
  const board = path.join(root, "board");
  assert.equal(
    make(root, ["--repo", board, "--port", "4999", "--out", path.join(root, "out")]).status,
    0,
  );

  const config = fs.readFileSync(
    path.join(root, "out", "Local Jira.app", "Contents", "Resources", "config.sh"),
    "utf8",
  );
  assert.match(config, new RegExp(`BOARD_REPO='${board}'`));
  assert.match(config, /PORT='4999'/);
  // Quoted, because a Mac path with a space in it is the ordinary case.
  assert.match(config, /CLI='[^']*cli\.ts'/);
});

test("a directory with no board is refused before anything is written", (t) => {
  const root = sandbox(t);
  const empty = path.join(root, "not-a-board");
  fs.mkdirSync(empty);

  const refused = make(root, ["--repo", empty, "--out", path.join(root, "out")]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /localjira init/);
  assert.equal(
    fs.existsSync(path.join(root, "out")),
    false,
    "a refused build leaves no half-made bundle behind",
  );
});

test("--repo is required, because there is no sensible default board", (t) => {
  const root = sandbox(t);
  const refused = make(root, ["--out", path.join(root, "out")]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--repo/);
});

/**
 * The icon is drawn rather than shipped, so it can be wrong in a way no
 * dependency would be.
 *
 * Checked as pixels, before encoding. A first version of this test searched the
 * finished PNG for the ink bytes and failed on a perfectly good icon, because a
 * PNG is compressed — the test was wrong, not the icon. Reading the buffer the
 * drawing produced is both simpler and the thing that actually broke.
 */
test("the mark is drawn at every size the bundle uses", () => {
  const inkOf = (size: number): number => {
    const pixels = iconPixels(size);
    let ink = 0;
    for (let at = 0; at < pixels.length; at += 3) {
      if (pixels[at] === ICON_INK[0] && pixels[at + 1] === ICON_INK[1]) {
        ink += 1;
      }
    }
    return ink;
  };

  // 16 is where rounding bites: at that size a stroke is one pixel wide, and
  // the fractional coordinates that once dropped the J silently would leave a
  // plain square here first.
  for (const size of [16, 32, 64, 128, 256, 512]) {
    const ink = inkOf(size);
    assert.ok(ink > 0, `${size}px icon is a blank square`);
    // Between "nothing drew" and "everything is ink": the mark covers a
    // recognisable slice and not the whole tile.
    const share = ink / (size * size);
    assert.ok(share > 0.02 && share < 0.4, `${size}px ink share ${share.toFixed(3)}`);
  }

  // Named points, not halves. Counting ink in the right-hand half passed on the
  // broken icon, because the J's stem drew and only its hook and top bar went
  // missing — the thing on screen read "L I" and the assertion could not tell.
  const size = 512;
  const pixels = iconPixels(size);
  const unit = size / 16;
  const isInk = (ux: number, uy: number): boolean => {
    const at = (Math.round(uy * unit) * size + Math.round(ux * unit)) * 3;
    return pixels[at] === ICON_INK[0] && pixels[at + 1] === ICON_INK[1];
  };

  assert.ok(isInk(3.5, 7), "the L has no stem");
  assert.ok(isInk(5.5, 10.6), "the L has no foot");
  assert.ok(isInk(11, 7), "the J has no stem");
  // The two that vanished. Both sat at fractional x and were dropped in silence.
  assert.ok(isInk(9.5, 4.5), "the J has no bar over it");
  assert.ok(isInk(9.5, 10), "the J has no hook");

  // And the tile is not simply flooded: the corners stay background, so an
  // all-ink bitmap would fail rather than sail through every check above.
  assert.equal(isInk(0.5, 0.5), false, "the icon is a solid block of ink");
  assert.equal(isInk(15.5, 15.5), false, "the icon is a solid block of ink");
});

test("the built icns is a real icon file", (t) => {
  const root = sandbox(t);
  assert.equal(
    make(root, ["--repo", path.join(root, "board"), "--out", path.join(root, "out")]).status,
    0,
  );

  const icns = path.join(root, "out", "Local Jira.app", "Contents", "Resources", "AppIcon.icns");
  if (!fs.existsSync(icns)) {
    // `iconutil` is macOS only. Elsewhere the builder says so and carries on,
    // which is the documented behaviour rather than a failure.
    assert.notEqual(process.platform, "darwin", "macOS has iconutil, so the icon must be there");
    return;
  }
  const bytes = fs.readFileSync(icns);
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "icns");
  assert.ok(bytes.length > 2_000, `an icns of ${bytes.length} bytes has no image in it`);
});

test("the iconset is cleaned up, leaving only the icns", (t) => {
  const root = sandbox(t);
  make(root, ["--repo", path.join(root, "board"), "--out", path.join(root, "out")]);
  const resources = path.join(root, "out", "Local Jira.app", "Contents", "Resources");
  assert.equal(
    fs.existsSync(path.join(resources, "AppIcon.iconset")),
    false,
    "the intermediate iconset directory does not belong in a shipped bundle",
  );
});

/**
 * The window has to have a way out of wherever it lands.
 *
 * Pressing 내보내기 used to set `window.location` to `/export.csv`. A browser
 * treats that as a download and stays put; WebKit rendered the CSV in place, the
 * board was gone, and with no address bar and no Back the only way out was to
 * quit the app. The export no longer navigates, but a window with no Back is a
 * window somebody can be trapped in — so both halves are checked (r29).
 */
test("the window can go back, and can always return to the board", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../../scripts/window.swift", import.meta.url)),
    "utf8",
  );
  for (const item of ["뒤로", "앞으로", "보드로"]) {
    assert.ok(source.includes(`"${item}"`), `보기 메뉴에 ${item}가 없다`);
  }
  // 보드로 reloads the start URL rather than walking history: Back is no help
  // when the very first page was the wrong one.
  assert.match(source, /func goHome\(\)[\s\S]*?load\(URLRequest\(url: boardURL\)\)/);
});

test("a file response becomes a download instead of replacing the app", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../../scripts/window.swift", import.meta.url)),
    "utf8",
  );
  assert.match(source, /decidePolicyFor response: WKNavigationResponse/);
  assert.match(source, /Content-Disposition/);
  assert.match(source, /decisionHandler\(\.download\)/);
  // Both routes to a download: a response that turns out to be a file, and a
  // link that says `download` — the blob the export uses takes the second.
  assert.match(source, /navigationResponse: WKNavigationResponse,\s*\n?\s*didBecome download/);
  assert.match(source, /navigationAction: WKNavigationAction,\s*\n?\s*didBecome download/);
});

test("the export does not navigate the page", () => {
  const app = fs.readFileSync(
    fileURLToPath(new URL("../../src/web/app.js", import.meta.url)),
    "utf8",
  );
  const body = /async function exportCurrent[\s\S]*?\n}/.exec(app);
  assert.ok(body, "exportCurrent not found");
  assert.equal(
    /window\.location/.test(body[0]),
    false,
    "setting location is what stranded the desktop window",
  );
  assert.match(body[0], /createObjectURL/);
  assert.match(body[0], /download = filename/);
});
