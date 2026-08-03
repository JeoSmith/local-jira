/**
 * Builds a macOS `.app` that starts the board and opens it in its own window.
 *
 * The ask was "an icon I click, and a window opens with the server already
 * running". The obvious answer is Electron or Tauri, and both would end S2-D1 —
 * the decision that this product ships with **zero dependencies**, which is why
 * the UI is vanilla ES modules and the tests are `node:test`.
 *
 * A `.app` is a directory with a plist and an executable, so the bundle is
 * written here with `fs`. The window is a Chromium window in `--app` mode: no
 * tabs, no address bar, its own Dock entry. That is a browser somebody already
 * has rather than a runtime this project now has to ship, update and audit
 * (S6-D6).
 *
 * What it costs: the window needs a Chromium browser installed, and without one
 * the launcher falls back to the default browser. Said plainly in the docs
 * rather than papered over.
 *
 * Usage:
 *   node scripts/make-app.ts --repo <보드가 있는 저장소> [--port 4173]
 *                            [--out ./dist] [--name "Local Jira"]
 */

import { deflateSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Options {
  repo: string;
  port: number;
  out: string;
  name: string;
}

function parse(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag.startsWith("--")) {
      values.set(flag, argv[index + 1] ?? "");
      index += 1;
    }
  }

  const repo = values.get("--repo");
  if (repo === undefined || repo === "") {
    throw new Error(
      "--repo is required: the repository whose .localjira the app should open.",
    );
  }
  if (!fs.existsSync(path.join(repo, ".localjira"))) {
    // Better here than as a blank window three clicks later.
    throw new Error(`${repo} has no .localjira. Run \`localjira init\` there first.`);
  }

  return {
    repo: fs.realpathSync(repo),
    port: Number(values.get("--port") ?? 4173),
    // Not `~/Applications` by default: a build script that writes outside the
    // directory it was run in, without being asked, is a surprise.
    out: values.get("--out") ?? path.join(process.cwd(), "dist"),
    name: values.get("--name") ?? "Local Jira",
  };
}

/**
 * The launcher.
 *
 * `sh`, not `bash` — this runs on whatever macOS ships. The server is a child
 * of this script and the trap is what makes quitting the app stop it; without
 * that a closed window would leave a server listening with nothing pointing at
 * it.
 *
 * If a server is already up on the port, it is left alone: somebody running
 * `localjira serve` in a terminal should not have it killed by closing a window
 * they opened afterwards.
 */
function launcher(options: Options): string {
  return `#!/bin/sh
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../Resources/config.sh"

URL="http://127.0.0.1:$PORT/"
LOG="\${TMPDIR:-/tmp}/local-jira-app.log"
NODE=$(command -v node || echo /usr/local/bin/node)
STARTED_BY_US=""

# Only kills what this launcher started.
cleanup() {
  if [ -n "$STARTED_BY_US" ]; then
    kill "$STARTED_BY_US" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

alive() {
  curl -s -o /dev/null --max-time 1 "$URL"
}

if ! alive; then
  ( cd "$BOARD_REPO" && exec "$NODE" "$CLI" serve --port "$PORT" ) >"$LOG" 2>&1 &
  STARTED_BY_US=$!
  attempts=0
  while [ $attempts -lt 75 ]; do
    alive && break
    # The server may have failed outright — a broken board, a taken port.
    kill -0 "$STARTED_BY_US" 2>/dev/null || break
    sleep 0.2
    attempts=$((attempts + 1))
  done
fi

if ! alive; then
  osascript -e 'display alert "Local Jira" message "보드를 열지 못했습니다. 자세한 내용은 '"$LOG"' 을 보세요."' >/dev/null 2>&1
  exit 1
fi

# Its own profile directory, so this window is a separate instance with its own
# Dock entry and does not merge into a browser session already open.
PROFILE="$HOME/Library/Application Support/$APP_NAME/window"
mkdir -p "$PROFILE"

for candidate in \\
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \\
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \\
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
do
  if [ -x "$candidate" ]; then
    # Foreground on purpose: this call returns when the window's instance quits,
    # and that is what stops the server.
    "$candidate" --app="$URL" --user-data-dir="$PROFILE" \\
      --no-first-run --no-default-browser-check \\
      --window-size=1280,860 >/dev/null 2>&1
    exit 0
  fi
done

# No Chromium-family browser. The default browser still shows the board, but in
# an ordinary tab, and there is no window whose closing can stop the server —
# so the server is left running rather than killed under a visible page.
STARTED_BY_US=""
open "$URL"
`;
}

function plist(options: Options): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${options.name}</string>
  <key>CFBundleDisplayName</key><string>${options.name}</string>
  <key>CFBundleIdentifier</key><string>im.localjira.launcher</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

// ── icon ────────────────────────────────────────────────────────────────────

/**
 * A PNG, written by hand.
 *
 * `node:zlib` is in the runtime, so an encoder is a few lines and the project
 * stays at zero dependencies. The mark is drawn as rectangles — "LJ" in the
 * brand green — because rendering text would need a font and a rasteriser,
 * which is the whole thing this avoids.
 */
export const ICON_BACKGROUND = [0x24, 0x58, 0x3c];
export const ICON_INK = [0xe3, 0xee, 0xe7];

/** The mark as raw RGB, so it can be checked without decoding a PNG. */
export function iconPixels(size: number): Buffer {
  const BACKGROUND = ICON_BACKGROUND;
  const INK = ICON_INK;

  const pixels = Buffer.alloc(size * size * 3);
  for (let index = 0; index < size * size; index += 1) {
    pixels[index * 3] = BACKGROUND[0];
    pixels[index * 3 + 1] = BACKGROUND[1];
    pixels[index * 3 + 2] = BACKGROUND[2];
  }

  // Rounded, because a fractional index into a Buffer is not an error — the
  // write is simply dropped. The first draft put the J's hook at x=268.8 and
  // the icon came out reading "L I" with no hint that anything had failed.
  const fill = (x0: number, y0: number, x1: number, y1: number): void => {
    const left = Math.max(0, Math.round(x0));
    const right = Math.min(size, Math.round(x1));
    const top = Math.max(0, Math.round(y0));
    const bottom = Math.min(size, Math.round(y1));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const at = (y * size + x) * 3;
        pixels[at] = INK[0];
        pixels[at + 1] = INK[1];
        pixels[at + 2] = INK[2];
      }
    }
  };

  const unit = size / 16;
  // L: a stem and a foot.
  fill(unit * 3, unit * 4, unit * 4.2, unit * 11.2);
  fill(unit * 3, unit * 10, unit * 7, unit * 11.2);
  // J: a hook and the bar over it.
  fill(unit * 10.5, unit * 4, unit * 11.7, unit * 10);
  fill(unit * 8.4, unit * 9.2, unit * 11.7, unit * 11.2);
  fill(unit * 8.4, unit * 4, unit * 13, unit * 5.1);

  return pixels;
}

function png(size: number): Buffer {
  const pixels = iconPixels(size);

  // Each row is prefixed with a filter byte; 0 means "store as is".
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 3 + 1)] = 0;
    pixels.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }

  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const tagged = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tagged));
    return Buffer.concat([length, tagged, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Turns the PNG into an `.icns`, when the tools to do it are there.
 *
 * `iconutil` and `sips` ship with macOS, so this needs nothing installed — but
 * it is also the one step that cannot run on Linux, and a missing icon is a
 * cosmetic loss rather than a broken app. So it reports and carries on.
 */
function writeIcon(resources: string): boolean {
  const iconset = path.join(resources, "AppIcon.iconset");
  fs.mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 64, 128, 256, 512]) {
    fs.writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), png(size));
    fs.writeFileSync(path.join(iconset, `icon_${size / 2}x${size / 2}@2x.png`), png(size));
  }

  const made = spawnSync("iconutil", [
    "-c", "icns", iconset, "-o", path.join(resources, "AppIcon.icns"),
  ], { encoding: "utf8" });

  fs.rmSync(iconset, { recursive: true, force: true });
  return made.status === 0;
}

// ── build ───────────────────────────────────────────────────────────────────

/**
 * Compiles the real window, when the machine can.
 *
 * `swiftc` comes with the Xcode Command Line Tools and `WKWebView` comes with
 * macOS, so this adds nothing to install — but a machine without the tools is
 * ordinary, and there the browser launcher still works. Native when it can,
 * a shortcut when it cannot, and the build says which one it made.
 */
function compileWindow(macos: string, options: Options): boolean {
  const source = path.join(ROOT, "scripts", "window.swift");
  if (!fs.existsSync(source)) {
    return false;
  }
  const made = spawnSync(
    "swiftc",
    ["-O", "-o", path.join(macos, options.name), source],
    { encoding: "utf8" },
  );
  if (made.status !== 0) {
    if (made.stderr) {
      process.stderr.write(`swiftc: ${made.stderr.split("\n")[0]}\n`);
    }
    return false;
  }
  return true;
}

/**
 * A shim that hands the binary its board and then execs it.
 *
 * The window reads its settings from the environment so one compiled binary can
 * serve any board; something has to put them there, and a bundle's executable
 * is the only entry point macOS will call.
 */
function shim(options: Options): string {
  return `#!/bin/sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../Resources/config.sh"

LJ_REPO="$BOARD_REPO" \\
LJ_CLI="$CLI" \\
LJ_PORT="$PORT" \\
LJ_NODE="$(command -v node || echo /usr/local/bin/node)" \\
exec "$HERE/${options.name}"
`;
}

function build(options: Options): string {
  const bundle = path.join(options.out, `${options.name}.app`);
  const macos = path.join(bundle, "Contents", "MacOS");
  const resources = path.join(bundle, "Contents", "Resources");

  fs.rmSync(bundle, { recursive: true, force: true });
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });

  fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), plist(options));
  fs.writeFileSync(
    path.join(resources, "config.sh"),
    // Quoted, because a path with a space in it is the normal case on macOS.
    `BOARD_REPO='${options.repo}'\n` +
      `CLI='${path.join(ROOT, "src", "cli.ts")}'\n` +
      `PORT='${options.port}'\n` +
      `APP_NAME='${options.name}'\n`,
  );

  const native = compileWindow(macos, options);
  const executable = path.join(macos, "launcher");
  fs.writeFileSync(executable, native ? shim(options) : launcher(options));
  fs.chmodSync(executable, 0o755);

  const icon = writeIcon(resources);

  // Ad-hoc, so macOS will launch a bundle whose executable was just written.
  // Without it a rebuilt app fails with "Launchd job spawn failed" and nothing
  // in the message points at the signature.
  spawnSync("codesign", ["--force", "--deep", "-s", "-", bundle], { encoding: "utf8" });

  process.stdout.write(
    `${bundle}\n` +
      `  보드   ${options.repo}\n` +
      `  포트   ${options.port}\n` +
      `  창     ${
        native
          ? "네이티브 (WKWebView) — 독에 이 앱 이름과 아이콘으로 뜹니다"
          : "브라우저 앱 모드 — swiftc가 없어 독에는 브라우저로 뜹니다"
      }\n` +
      `  아이콘 ${icon ? "생성함" : "건너뜀 (iconutil 없음 — 기본 아이콘으로 뜹니다)"}\n` +
      "\n" +
      "  ~/Applications 로 옮기면 런치패드와 스포트라이트에 나옵니다.\n",
  );
  return bundle;
}

// Only when run as a command. The test imports `iconPixels`, and an import
// that starts building a bundle would be a surprising thing to import.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  build(parse(process.argv.slice(2)));
}
