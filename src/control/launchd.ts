// src/control/launchd.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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

export function renderPlist(nodeBin: string, daemonEntry: string): string {
  const logPath = join(homedir(), ".config", "cockpit", "cockpitd.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(nodeBin)}</string><string>${xmlEscape(daemonEntry)}</string></array>
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
 * Idempotent: (re)write plist and (re)load it. Never throws fatally.
 * The daemon entry is resolved internally (see daemonEntryPath) so no caller
 * can pass a wrong path. `nodeBin` defaults to the running node.
 */
export function ensureDaemon(nodeBin: string = process.execPath): void {
  try {
    const p = plistPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, renderPlist(nodeBin, daemonEntryPath()));
    const uid = process.getuid?.() ?? 0;
    try { execFileSync("launchctl", ["bootstrap", `gui/${uid}`, p], { stdio: "ignore" }); }
    catch { /* already bootstrapped */ }
    execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
  } catch (e) {
    // daemon ensure is best-effort (still don't throw); CLI fails loud on socket miss
    process.stderr.write(`[cockpit] warn: ensureDaemon failed (${e instanceof Error ? e.message : e})\n`);
  }
}
