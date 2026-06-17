// src/control/launchd.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync, writeSync, closeSync, unlinkSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LABEL = "com.cockpit.daemon";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

/**
 * Canonical path to the compiled daemon entrypoint, resolved relative to THIS
 * module (cockpitd.js is a sibling of the bundled entry in <dist>/). This is
 * the single source of truth — callers must NOT recompute it (a hardcoded
 * ~/.config/cockpit/dist path crash-loops the agent with MODULE_NOT_FOUND
 * because runtime-sync never mirrors compiled output there).
 */
export function daemonEntryPath(): string {
  const p = join(dirname(fileURLToPath(import.meta.url)), "cockpitd.js");
  if (!existsSync(p)) {
    throw new Error(
      `daemonEntryPath: compiled entry not found at '${p}'; ` +
      `run 'npm run build' — a src-tree or missing path in the launchd plist causes a MODULE_NOT_FOUND crash-loop (#259)`,
    );
  }
  return p;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Strip per-shell ephemeral PATH entries (Claude Code plugin cache dirs) and
 * dedupe so the plist content is stable across cockpit invocations from
 * different shells. Without this, a captain shell (PATH includes
 * ~/.claude/plugins/cache/* bin dirs) vs a fresh login shell would each
 * rewrite the plist and kickstart -k the daemon, killing in-flight tasks
 * (incident 2026-05-21, observations 8704/8707/8711).
 */
export function sanitizePathForPlist(path: string): string {
  const seen = new Set<string>();
  const stable: string[] = [];
  for (const p of path.split(":")) {
    if (!p) continue;
    if (p.includes("/.claude/plugins/")) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    stable.push(p);
  }
  return stable.join(":");
}

export const AGENT_BINS = ["cmux", "claude", "opencode", "codex", "gemini", "node"];

/**
 * Resolve absolute directories for known agent + tool binaries via `which`, so
 * the launchd daemon's PATH includes them regardless of the install-time shell.
 * Missing binaries are skipped silently.
 */
export function resolveAgentBinDirs(): string[] {
  const dirs: string[] = [];
  for (const bin of AGENT_BINS) {
    try {
      const out = execFileSync("which", [bin], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      const resolved = out.trim();
      if (resolved) dirs.push(dirname(resolved));
    } catch {
      // binary not found on this machine — skip
    }
  }
  const seen = new Set<string>();
  return dirs.filter(d => {
    if (seen.has(d)) return false;
    seen.add(d);
    return true;
  });
}

/**
 * Compose a stable daemon PATH by prepending resolved agent bin dirs to the
 * sanitized install-shell PATH.  Agent dirs take priority (prepended) and are
 * deduped against the sanitized entries so the output is deterministic.
 */
export function buildDaemonPath(shellPath: string): string {
  const agentDirs = resolveAgentBinDirs();
  const sanitized = sanitizePathForPlist(shellPath);
  if (agentDirs.length === 0) return sanitized;
  const parts = [...agentDirs, ...sanitized.split(":")];
  const seen = new Set<string>();
  return parts.filter(p => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  }).join(":");
}

/**
 * Red-team #3 (High): launchd starts the daemon with a minimal PATH that does
 * NOT include where `claude`/`codex`/`opencode` live (nvm/cmux dirs), so every
 * headless `spawn` failed `ENOENT` in the real deployment (shell tests + fake
 * spawn hid it). We bake the installing process's PATH into the plist so the
 * daemon and its spawned crew children resolve the provider binaries.
 */
export function renderPlist(nodeBin: string, daemonEntry: string, pathEnv = ""): string {
  const logPath = join(homedir(), ".config", "cockpit", "cockpitd.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(nodeBin)}</string><string>${xmlEscape(daemonEntry)}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xmlEscape(pathEnv)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Semantic fingerprint of the <array> block inside the rendered plist. Used by
 * ensureDaemon to distinguish program-argument changes (merit a full restart)
 * from PATH-only changes (write updated plist, don't bounce the daemon).
 */
export function programArgsBlock(nodeBin: string, daemonEntry: string): string {
  return `<array><string>${xmlEscape(nodeBin)}</string><string>${xmlEscape(daemonEntry)}</string></array>`;
}

/**
 * Pure: which kickstart argv to use. `-k` (kill-then-restart) ONLY when the
 * plist changed. A plain `kickstart` starts a down daemon and is a no-op for a
 * healthy one — so a routine CLI call never bounces a running daemon (this was
 * a real bug: ensureDaemon ran on every `cockpit` invocation and `kickstart -k`
 * killed+restarted the daemon each time, orphaning in-flight headless crew).
 */
export function kickstartArgv(target: string, plistChanged: boolean): string[] {
  return plistChanged ? ["kickstart", "-k", target] : ["kickstart", target];
}

// In-process dedup: JS is single-threaded and ensureDaemon is synchronous, so
// true re-entrancy is impossible; this flag prevents sequential re-calls within
// the same process (e.g. index.ts + crew-control.ts) from re-running the
// bootout/bootstrap pair needlessly.
let restartInFlight = false;

/** @internal — reset only in tests; never call from production code */
export function _resetRestartInFlightForTest(): void {
  restartInFlight = false;
}

export function daemonLockPath(): string {
  return join(homedir(), ".config", "cockpit", "daemon.lock");
}

/**
 * Acquire a cross-process filesystem lock at ~/.config/cockpit/daemon.lock.
 * Uses O_EXCL for atomic, race-free creation. Cleans up stale locks (dead PID)
 * before the acquisition loop. Retries with a ~50 ms synchronous sleep up to
 * 20 times (~1 s total) before giving up.
 * Returns true on success, false if another live process holds the lock.
 */
export function tryAcquireDaemonLock(): boolean {
  const lp = daemonLockPath();

  // Stale-lock cleanup: if the owning PID is no longer alive, remove the file
  // so the next O_EXCL attempt succeeds.
  if (existsSync(lp)) {
    try {
      const pid = parseInt(readFileSync(lp, "utf-8").trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        unlinkSync(lp);
      } else {
        try { process.kill(pid, 0); }
        catch { unlinkSync(lp); } // ESRCH → process dead, steal the lock
      }
    } catch { /* read/parse/unlink error — fall through to O_EXCL attempt */ }
  }

  // Atomic acquisition: O_EXCL guarantees only one process creates the file.
  for (let i = 0; i < 20; i++) {
    try {
      const fd = openSync(lp, constants.O_EXCL | constants.O_CREAT | constants.O_WRONLY);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      if (i < 19) {
        // Synchronous sleep: gives the lock-holder time to finish and release.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  }
  return false; // another live process held the lock for > ~1 s — skip restart
}

/** Release the lock written by tryAcquireDaemonLock. */
export function releaseDaemonLock(): void {
  try { unlinkSync(daemonLockPath()); } catch { /* already cleaned up */ }
}

/**
 * Idempotent & cheap. Never throws fatally. Writes/reloads the plist ONLY when
 * its content actually changed; Distinguishes program-argument drift (warrants
 * a full restart via bootout + bootstrap + kickstart) from PATH-only drift
 * (write the plist for the next natural restart but never bounce a healthy
 * daemon). Uses plain `kickstart` (never -k) to avoid the race between -k and
 * bootout's exit handler that produced exit-113 "service not loaded" errors.
 * The daemon entry is resolved internally (see daemonEntryPath) so no caller
 * can pass a wrong path.
 *
 * Concurrency guards:
 *   - restartInFlight flag: prevents sequential re-calls within this process.
 *   - tryAcquireDaemonLock: serialises concurrent SEPARATE cockpit processes
 *     via a filesystem lock so only one runs bootout/bootstrap at a time.
 */
export function ensureDaemon(nodeBin: string = process.execPath): void {
  if (restartInFlight) return;
  restartInFlight = true;

  if (!tryAcquireDaemonLock()) {
    // Another process is handling the restart; it will be done by the time the
    // CLI tries to reach the daemon socket.
    return;
  }

  try {
    const p = plistPath();
    const entry = daemonEntryPath();
    const desired = renderPlist(nodeBin, entry, buildDaemonPath(process.env.PATH ?? ""));
    const current = existsSync(p) ? readFileSync(p, "utf-8") : null;
    const uid = process.getuid?.() ?? 0;
    const target = `gui/${uid}/${LABEL}`;

    const changed = current !== desired;
    // Semantic comparison: was the program-arg block itself different (not just
    // PATH)?  Program-arg changes are rare (rebuild/reinstall) and merit a full
    // bootout+reload; PATH varies across terminals so it must NOT trigger a
    // bounce (would orphan in-flight RPCs).
    const programChanged = current !== null && changed
      && !current.includes(programArgsBlock(nodeBin, entry));

    if (changed) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, desired);
    }

    if (programChanged) {
      // unload the old instance so bootstrap picks up the new program args
      try { execFileSync("launchctl", ["bootout", target], { stdio: "ignore" }); }
      catch { /* not loaded */ }
    }

    try { execFileSync("launchctl", ["bootstrap", `gui/${uid}`, p], { stdio: "ignore" }); }
    catch { /* already bootstrapped */ }

    // Plain kickstart (never -k): no-op on a healthy daemon, starts one that
    // was booted-out above or that stopped for other reasons.  -k is avoided
    // because it races with bootout's exit handler and produces exit-113 when
    // the service hasn't finished unloading.
    execFileSync("launchctl", ["kickstart", target], { stdio: "ignore" });
  } catch (e) {
    // daemon ensure is best-effort (still don't throw); CLI fails loud on socket miss
    process.stderr.write(`[cockpit] warn: ensureDaemon failed (${e instanceof Error ? e.message : e})\n`);
  } finally {
    releaseDaemonLock();
  }
}
