import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  acquireBootstrapLock,
  bootstrapLockPath,
  BootstrapBusyError,
  isLockSupportedPlatform,
  BOOTSTRAP_LOCK_FILENAME,
} from "../../src/bootstrap/lock.ts";

const LOCK_MODULE_URL = new URL("../../src/bootstrap/lock.ts", import.meta.url)
  .href;
const supported = isLockSupportedPlatform();

function makeCommonDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localjira-lock-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("derives the lock path from the git common dir", () => {
  assert.equal(
    bootstrapLockPath("/repo/.git"),
    path.join("/repo/.git", BOOTSTRAP_LOCK_FILENAME),
  );
});

test("rejects a second acquisition while the lock is held", { skip: !supported }, async (t) => {
  const commonDir = makeCommonDir(t);

  const first = await acquireBootstrapLock(commonDir);
  t.after(() => first.release());

  assert.equal(first.held, true);
  await assert.rejects(
    () => acquireBootstrapLock(commonDir),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapBusyError);
      assert.equal(error.code, "E_BOOTSTRAP_BUSY");
      assert.equal(error.lockPath, bootstrapLockPath(commonDir));
      return true;
    },
  );
});

test("re-acquires after release", { skip: !supported }, async (t) => {
  const commonDir = makeCommonDir(t);

  const first = await acquireBootstrapLock(commonDir);
  first.release();
  assert.equal(first.held, false);

  const second = await acquireBootstrapLock(commonDir);
  t.after(() => second.release());
  assert.equal(second.held, true);
});

test("release is idempotent", { skip: !supported }, async (t) => {
  const commonDir = makeCommonDir(t);

  const lock = await acquireBootstrapLock(commonDir);
  lock.release();
  lock.release();

  const again = await acquireBootstrapLock(commonDir);
  t.after(() => again.release());
  assert.equal(again.held, true);
});

test("ownership never depends on the lock file existing", { skip: !supported }, async (t) => {
  const commonDir = makeCommonDir(t);
  const lockPath = bootstrapLockPath(commonDir);

  const lock = await acquireBootstrapLock(commonDir);
  t.after(() => lock.release());

  // The file is created, but its presence is not what grants ownership: a
  // second acquisition is refused by the kernel, not by an existence check.
  assert.equal(fs.existsSync(lockPath), true);
  await assert.rejects(() => acquireBootstrapLock(commonDir), BootstrapBusyError);

  lock.release();
  // Released without deleting the file — the next acquisition still succeeds,
  // so no stale-file cleanup path exists to get wrong (ADR-002).
  assert.equal(fs.existsSync(lockPath), true);
  const next = await acquireBootstrapLock(commonDir);
  t.after(() => next.release());
  assert.equal(next.held, true);
});

test("creates the lock file with owner-only permissions", { skip: !supported || process.platform === "win32" }, async (t) => {
  const commonDir = makeCommonDir(t);

  const lock = await acquireBootstrapLock(commonDir);
  t.after(() => lock.release());

  const mode = fs.statSync(bootstrapLockPath(commonDir)).mode & 0o777;
  assert.equal(mode & 0o077, 0, `expected owner-only mode, got ${mode.toString(8)}`);
});

test("the kernel releases the lock when the holding process is killed", { skip: !supported }, async (t) => {
  const commonDir = makeCommonDir(t);
  const holderPath = path.join(commonDir, "holder.ts");

  fs.writeFileSync(
    holderPath,
    [
      `import { acquireBootstrapLock } from ${JSON.stringify(LOCK_MODULE_URL)};`,
      "const lock = await acquireBootstrapLock(process.argv[2]);",
      'process.stdout.write("HELD\\n");',
      "setInterval(() => {}, 1000);",
      "void lock;",
      "",
    ].join("\n"),
  );

  const holder = spawn(process.execPath, [holderPath, commonDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => holder.kill("SIGKILL"));

  const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("holder did not acquire the lock in time")),
      15_000,
    );
    holder.stdout.setEncoding("utf8");
    holder.stdout.on("data", (chunk: string) => {
      if (chunk.includes("HELD")) {
        clearTimeout(timer);
        resolve();
      }
    });
    holder.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  // Another process holds it, so we must be refused.
  await assert.rejects(() => acquireBootstrapLock(commonDir), BootstrapBusyError);

  // SIGKILL gives the holder no chance to clean up. The lock must still go.
  holder.kill("SIGKILL");
  await exited;

  const recovered = await acquireBootstrapLock(commonDir);
  t.after(() => recovered.release());
  assert.equal(recovered.held, true);
});
