// src/control/launchd.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LABEL = "com.cockpit.daemon";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

/**
 * Canonical path to the compiled daemon entrypoint, resolved relative to THIS
 * module (cockpitd.js is a sibling of launchd.js in <dist>/control/). This is
 * the single source of truth — callers must NOT recompute it (a hardcoded
 * ~/.config/cockpit/dist path crash-loops the agent with MODULE_NOT_FOUND
 * because runtime-sync never mirrors compiled output there).
 */
export function daemonEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cockpitd.js");
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
 * Pure: which kickstart argv to use. `-k` (kill-then-restart) ONLY when the
 * plist changed. A plain `kickstart` starts a down daemon and is a no-op for a
 * healthy one — so a routine CLI call never bounces a running daemon (this was
 * a real bug: ensureDaemon ran on every `cockpit` invocation and `kickstart -k`
 * killed+restarted the daemon each time, orphaning in-flight headless crew).
 */
export function kickstartArgv(target: string, plistChanged: boolean): string[] {
  return plistChanged ? ["kickstart", "-k", target] : ["kickstart", target];
}

/**
 * Idempotent & cheap. Never throws fatally. Writes/reloads the plist ONLY when
 * its content actually changed; otherwise it ensures the daemon is running
 * without killing a healthy one. The daemon entry is resolved internally
 * (see daemonEntryPath) so no caller can pass a wrong path.
 */
export function ensureDaemon(nodeBin: string = process.execPath): void {
  try {
    const p = plistPath();
    const desired = renderPlist(nodeBin, daemonEntryPath(), process.env.PATH ?? "");
    const current = existsSync(p) ? readFileSync(p, "utf-8") : null;
    const changed = current !== desired;
    if (changed) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, desired);
    }
    const uid = process.getuid?.() ?? 0;
    const target = `gui/${uid}/${LABEL}`;
    if (changed) {
      // plist changed → drop the old instance so the new config takes effect
      try { execFileSync("launchctl", ["bootout", target], { stdio: "ignore" }); }
      catch { /* not loaded */ }
    }
    try { execFileSync("launchctl", ["bootstrap", `gui/${uid}`, p], { stdio: "ignore" }); }
    catch { /* already bootstrapped */ }
    // -k only when the plist changed: a routine CLI call must not restart a
    // healthy daemon (would orphan its in-flight headless children).
    execFileSync("launchctl", kickstartArgv(target, changed), { stdio: "ignore" });
  } catch (e) {
    // daemon ensure is best-effort (still don't throw); CLI fails loud on socket miss
    process.stderr.write(`[cockpit] warn: ensureDaemon failed (${e instanceof Error ? e.message : e})\n`);
  }
}
