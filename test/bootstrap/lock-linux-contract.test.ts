import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  acquireBootstrapLock,
  acquireWithFlockHelper,
  BootstrapBusyError,
  BootstrapLockUnsupportedError,
} from "../../src/bootstrap/lock.ts";

/**
 * The Linux path holds the lock through `flock(1)`, and this machine is macOS,
 * so the kernel behaviour cannot be exercised here. What *can* be pinned down
 * is the contract with the helper: the argument vector, the "acquired" marker,
 * the conflict exit code, and that the parent keeps stdin open.
 *
 * A stub `flock` on PATH covers exactly that. It does not prove the lock works
 * on Linux — that still needs a Linux run (see the M0 verification note).
 */

interface Stub {
  dir: string;
  argvLog: string;
  env: NodeJS.ProcessEnv;
}

function installStubFlock(
  t: { after: (fn: () => void) => void },
  body: string,
): Stub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localjira-flock-stub-"));
  const argvLog = path.join(dir, "argv.log");
  const stub = path.join(dir, "flock");

  fs.writeFileSync(
    stub,
    ["#!/bin/sh", `printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`, body, ""].join("\n"),
  );
  fs.chmodSync(stub, 0o755);

  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    argvLog,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
  };
}

function withPath<T>(dir: string, body: () => T): T {
  const original = process.env.PATH;
  process.env.PATH = `${dir}:${original ?? ""}`;
  try {
    return body();
  } finally {
    process.env.PATH = original;
  }
}

test("invokes flock with a non-blocking exclusive request and a distinct conflict code", async (t) => {
  // Succeeds: emit the marker, then block on stdin the way `cat` would.
  const stub = installStubFlock(t, 'printf R\nexec cat');
  const lockPath = path.join(stub.dir, "board.lock");

  const lock = await withPath(stub.dir, () => acquireWithFlockHelper(lockPath));
  t.after(() => lock.release());

  const argv = fs.readFileSync(stub.argvLog, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(argv, [
    "--exclusive",
    "--nonblock",
    "--conflict-exit-code",
    "75",
    lockPath,
    "sh",
    "-c",
    "printf %s R; exec cat",
  ]);
  assert.equal(lock.mechanism, "linux_flock_helper");
  assert.equal(lock.held, true);
});

test("maps the conflict exit code to E_BOOTSTRAP_BUSY", async (t) => {
  const stub = installStubFlock(t, "exit 75");
  const lockPath = path.join(stub.dir, "board.lock");

  await withPath(stub.dir, async () => {
    await assert.rejects(
      () => acquireWithFlockHelper(lockPath),
      (error: unknown) => {
        assert.ok(error instanceof BootstrapBusyError);
        assert.equal(error.code, "E_BOOTSTRAP_BUSY");
        return true;
      },
    );
  });
});

test("does not mistake an unrelated helper failure for contention", async (t) => {
  // flock itself failing (bad usage, missing file) must not read as "busy",
  // or bootstrap would tell the user to wait for a command nobody is running.
  const stub = installStubFlock(t, 'echo "flock: bad usage" >&2\nexit 1');
  const lockPath = path.join(stub.dir, "board.lock");

  await withPath(stub.dir, async () => {
    await assert.rejects(
      () => acquireWithFlockHelper(lockPath),
      (error: unknown) => {
        assert.ok(!(error instanceof BootstrapBusyError));
        assert.match((error as Error).message, /exited with code 1/);
        assert.match((error as Error).message, /bad usage/);
        return true;
      },
    );
  });
});

test("releasing closes the helper's stdin so the kernel drops the lock", async (t) => {
  const marker = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "localjira-flock-exit-")),
    "exited",
  );
  t.after(() => fs.rmSync(path.dirname(marker), { recursive: true, force: true }));

  // Records that it observed EOF on stdin rather than being killed outright.
  const stub = installStubFlock(
    t,
    `printf R\ncat > /dev/null\nprintf eof > ${JSON.stringify(marker)}`,
  );
  const lockPath = path.join(stub.dir, "board.lock");

  const lock = await withPath(stub.dir, () => acquireWithFlockHelper(lockPath));
  assert.equal(lock.held, true);

  lock.release();
  assert.equal(lock.held, false);

  await waitFor(() => fs.existsSync(marker), 5_000);
  assert.equal(fs.readFileSync(marker, "utf8"), "eof");
});

test("refuses platforms without an implemented locking primitive", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localjira-lock-plat-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Windows must fail loudly rather than run unlocked (OQ-M0-1).
  await assert.rejects(
    () => acquireBootstrapLock(dir, "win32"),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapLockUnsupportedError);
      assert.equal(error.code, "E_PLATFORM_UNSUPPORTED");
      assert.match(error.message, /win32/);
      return true;
    },
  );
});

test("routes linux to the helper and bsd to the open flag", async (t) => {
  const stub = installStubFlock(t, "printf R\nexec cat");

  const linuxLock = await withPath(stub.dir, () =>
    acquireBootstrapLock(stub.dir, "linux"),
  );
  t.after(() => linuxLock.release());
  assert.equal(linuxLock.mechanism, "linux_flock_helper");

  const bsdDir = fs.mkdtempSync(path.join(os.tmpdir(), "localjira-lock-bsd-"));
  t.after(() => fs.rmSync(bsdDir, { recursive: true, force: true }));

  if (process.platform === "darwin") {
    const bsdLock = await acquireBootstrapLock(bsdDir, "darwin");
    t.after(() => bsdLock.release());
    assert.equal(bsdLock.mechanism, "bsd_o_exlock");
  }
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met in time");
}
