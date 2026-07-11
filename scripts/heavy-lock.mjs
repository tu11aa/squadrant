#!/usr/bin/env node
// Machine-wide semaphore for heavy commands (test runs, builds) so concurrent
// crews WAIT for a slot instead of piling up and saturating the machine (#570).
//
// macOS has no flock(1), so the lock is mkdir-based: mkdir is atomic on POSIX,
// so "did I create this directory" is a race-free ownership check. Each slot
// directory holds the holder's pid; a slot whose pid is no longer alive is
// stale (its holder crashed or was SIGKILLed) and gets reclaimed rather than
// deadlocking the repo forever.
//
// Usage: node scripts/heavy-lock.mjs -- <command> [args...]
// Env:   SQUADRANT_HEAVY_MAX (default 2) — max concurrent holders machine-wide.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX = Math.max(1, Number.parseInt(process.env.SQUADRANT_HEAVY_MAX, 10) || 2);
const LOCK_ROOT = join(tmpdir(), "squadrant-heavy-lock");
const POLL_MS = 1000;
const LOG_EVERY_MS = 10_000;

const sep = process.argv.indexOf("--");
if (sep === -1 || sep === process.argv.length - 1) {
  console.error("usage: node scripts/heavy-lock.mjs -- <command> [args...]");
  process.exit(1);
}
const command = process.argv[sep + 1];
const commandArgs = process.argv.slice(sep + 2);

mkdirSync(LOCK_ROOT, { recursive: true });

const slotDir = (n) => join(LOCK_ROOT, `slot-${n}`);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Returns true if we now own slot n. Reclaims the slot if its holder is dead.
function tryAcquire(n) {
  const dir = slotDir(n);
  try {
    mkdirSync(dir);
    writeFileSync(join(dir, "pid"), String(process.pid));
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  let holderPid;
  try {
    holderPid = Number.parseInt(readFileSync(join(dir, "pid"), "utf8"), 10);
  } catch {
    return false; // slot mid-creation by another process; contended, not stale
  }
  if (holderPid && isAlive(holderPid)) return false;
  // Stale slot (holder pid is dead) — reclaim. rmSync+mkdirSync isn't a single
  // atomic op, but the final mkdirSync is: if another process reclaims first,
  // ours throws EEXIST and we just loop around and try again.
  rmSync(dir, { recursive: true, force: true });
  try {
    mkdirSync(dir);
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  }
  writeFileSync(join(dir, "pid"), String(process.pid));
  return true;
}

function countBusy() {
  let busy = 0;
  for (let n = 0; n < MAX; n++) {
    try {
      readFileSync(join(slotDir(n), "pid"));
      busy++;
    } catch {
      // slot not held
    }
  }
  return busy;
}

async function acquireSlot() {
  let lastLog = 0;
  for (;;) {
    for (let n = 0; n < MAX; n++) {
      if (tryAcquire(n)) return n;
    }
    const now = Date.now();
    if (now - lastLog >= LOG_EVERY_MS) {
      console.error(`[heavy-lock] waiting for test slot (${countBusy()} ahead, max ${MAX} concurrent)...`);
      lastLog = now;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

let heldSlot = null;
function release() {
  if (heldSlot === null) return;
  const n = heldSlot;
  heldSlot = null;
  rmSync(slotDir(n), { recursive: true, force: true });
}
process.on("exit", release);

const slot = await acquireSlot();
heldSlot = slot;
console.error(`[heavy-lock] slot ${slot}/${MAX - 1} acquired — running: ${command} ${commandArgs.join(" ")}`);

const child = spawn(command, commandArgs, { stdio: "inherit" });
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

let exitCode;
try {
  exitCode = await new Promise((resolve, reject) => {
    child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    child.on("error", reject);
  });
} finally {
  release();
}
process.exit(exitCode);
