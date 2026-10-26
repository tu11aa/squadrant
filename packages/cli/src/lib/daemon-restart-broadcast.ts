// Best-effort "daemon restarted" broadcast to all running captains, fired on
// daemon boot — but only when the running version or install path changed, not
// on a same-install restart (heal daemon after a same-version reinstall, a
// config/project restart, a launchd crash-restart), and never twice in a row
// within NOTICE_COOLDOWN_MS. Routes through the
// mailbox (appendCaptainMessage) so the daemon's delivery-loop drains it with
// draft protection, instead of raw driver.send which clobbers the user's draft
// (#529).
import fs from "node:fs";
import path from "node:path";
import { type SquadrantConfig, readConfigFileSync, writeConfigFileSync } from "@squadrant/shared";

/** Minimal slice of RuntimeDriver used to resolve captain status. */
export interface DaemonRestartNotifyDriver {
  status(nameOrId: string): Promise<{ id: string } | null>;
}

/** Matches the appendCaptainMessage signature from @squadrant/core/mailbox.
 *  The caller provides the closure with stateRoot already bound. */
export type AppendCaptainMessageFn = (project: string, text: string) => Promise<void | number>;

function statePath(stateRoot: string): string {
  return path.join(stateRoot, "daemon-restart-state.json");
}

/** A notice within this window of the previous one is skipped (restart storm, A→B→A flip). */
export const NOTICE_COOLDOWN_MS = 5 * 60_000;

/** version + daemon install path. A same-path rebuild/reinstall is not a change worth a
 *  notice: until 2026-10-26 the build mtime was part of this, so every dev `npm i -g` +
 *  `heal daemon` notified every captain. */
export function computeRestartSignature(version: string, installPath: string): string {
  return `${version}::${installPath}`;
}

/** Pre-2026-10-26 signatures carried a numeric build mtime instead of a path. */
function isLegacySignatureOf(previous: string, version: string): boolean {
  const [v, rest] = previous.split("::");
  return v === version && rest !== undefined && /^[\d.]+$/.test(rest);
}

interface PersistedRestartState { signature?: string; lastNoticeAt?: number }

function readPersistedRestartState(stateRoot: string): PersistedRestartState {
  try {
    const data = JSON.parse(readConfigFileSync(statePath(stateRoot))) as PersistedRestartState;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function readPersistedRestartSignature(stateRoot: string): string | null {
  const { signature } = readPersistedRestartState(stateRoot);
  return typeof signature === "string" ? signature : null;
}

export function writePersistedRestartSignature(stateRoot: string, signature: string, lastNoticeAt?: number): void {
  const prev = readPersistedRestartState(stateRoot).lastNoticeAt;
  const data: PersistedRestartState = { signature, lastNoticeAt: lastNoticeAt ?? prev };
  writeConfigFileSync(statePath(stateRoot), JSON.stringify(data, null, 2) + "\n");
}

function restartNotice(version: string, pathChanged: boolean): string {
  const suffix = pathChanged ? " (new install path)" : "";
  return `⚠️ Daemon restarted → v${version}${suffix} (control-plane bounced). Re-verify in-flight crews — a crew mid-first-turn may need a crew send.`;
}

/**
 * Send the daemon-restart notice to every running captain via the mailbox.
 * Unlike notifyCaptainsOfEffort there is no initiating cwd captain to exclude —
 * the daemon boots independently of any captain — so this reaches ALL of them.
 * The appendCaptainMessage callback is a closure that captures stateRoot from
 * the caller (squadrantd.ts), so it takes (projectName, text).
 */
export async function notifyCaptainsOfDaemonRestart(
  version: string,
  config: SquadrantConfig,
  driver: DaemonRestartNotifyDriver,
  pathChanged = false,
  appendCaptainMessage: AppendCaptainMessageFn,
): Promise<void> {
  const notice = restartNotice(version, pathChanged);
  for (const [projName] of Object.entries(config.projects)) {
    try {
      const proj = config.projects[projName];
      const ref = await driver.status(proj.captainName);
      if (ref) {
        await appendCaptainMessage(projName, notice);
      }
    } catch {
      // individual project captain unreachable — skip
    }
  }
}

export interface MaybeBroadcastDaemonRestartOpts {
  version: string;
  /** The running daemon's entry file (squadrantd.js). */
  installPath: string;
  stateRoot: string;
  config: SquadrantConfig;
  driver: DaemonRestartNotifyDriver;
  appendCaptainMessage: AppendCaptainMessageFn;
  now?: () => number;
}

/**
 * Boot-time entry point: compare this boot's (version, install path) signature
 * against the last persisted one. Same → stay silent. Differs → persist, and
 * broadcast unless the previous notice went out less than NOTICE_COOLDOWN_MS
 * ago. Fully best-effort — never throws, so it can never block or crash daemon boot.
 */
export async function maybeBroadcastDaemonRestart(opts: MaybeBroadcastDaemonRestartOpts): Promise<void> {
  try {
    const { version, installPath, stateRoot, config, driver, appendCaptainMessage } = opts;
    const now = (opts.now ?? Date.now)();
    const signature = computeRestartSignature(version, installPath);
    const { signature: previous, lastNoticeAt } = readPersistedRestartState(stateRoot);
    if (previous === signature) return;
    if (previous !== undefined && isLegacySignatureOf(previous, version)) {
      writePersistedRestartSignature(stateRoot, signature);
      return;
    }
    if (lastNoticeAt !== undefined && now - lastNoticeAt < NOTICE_COOLDOWN_MS) {
      writePersistedRestartSignature(stateRoot, signature);
      return;
    }
    const pathChanged = previous !== undefined && previous.split("::")[0] === version;
    await notifyCaptainsOfDaemonRestart(version, config, driver, pathChanged, appendCaptainMessage);
    writePersistedRestartSignature(stateRoot, signature, now);
  } catch {
    // best-effort — never let a broadcast failure block or crash daemon boot
  }
}
