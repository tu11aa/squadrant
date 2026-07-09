// Best-effort "daemon restarted" broadcast to all running captains, fired on
// daemon boot — but only when the running build actually changed (version or
// local rebuild), not on a same-build launchd crash-restart. Routes through the
// mailbox (appendCaptainMessage) so the daemon's delivery-loop drains it with
// draft protection, instead of raw driver.send which clobbers the user's draft
// (#529).
import fs from "node:fs";
import path from "node:path";
import type { SquadrantConfig } from "@squadrant/shared";

/** Minimal slice of RuntimeDriver used to resolve captain status. */
export interface DaemonRestartNotifyDriver {
  status(nameOrId: string): Promise<{ id: string } | null>;
}

/** Matches the appendCaptainMessage signature from @squadrant/core/mailbox.
 *  The caller provides the closure with stateRoot already bound. */
export type AppendCaptainMessageFn = (project: string, text: string) => Promise<void>;

function statePath(stateRoot: string): string {
  return path.join(stateRoot, "daemon-restart-state.json");
}

/** version + build-file mtime — differs on a version bump AND on a local
 *  rebuild of the same version (mtime moves), but not on a plain restart. */
export function computeRestartSignature(version: string, buildMtimeMs: number): string {
  return `${version}::${buildMtimeMs}`;
}

export function readPersistedRestartSignature(stateRoot: string): string | null {
  try {
    const raw = fs.readFileSync(statePath(stateRoot), "utf-8");
    const data = JSON.parse(raw) as { signature?: string };
    return typeof data.signature === "string" ? data.signature : null;
  } catch {
    return null;
  }
}

export function writePersistedRestartSignature(stateRoot: string, signature: string): void {
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(statePath(stateRoot), JSON.stringify({ signature }, null, 2) + "\n");
}

function restartNotice(version: string, isDevRebuild: boolean): string {
  const suffix = isDevRebuild ? " (dev build)" : "";
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
  isDevRebuild = false,
  appendCaptainMessage?: AppendCaptainMessageFn,
): Promise<void> {
  const notice = appendCaptainMessage ? restartNotice(version, isDevRebuild) : "";
  for (const [projName] of Object.entries(config.projects)) {
    try {
      const proj = config.projects[projName];
      const ref = await driver.status(proj.captainName);
      if (ref && appendCaptainMessage) {
        await appendCaptainMessage(projName, notice);
      }
    } catch {
      // individual project captain unreachable — skip
    }
  }
}

export interface MaybeBroadcastDaemonRestartOpts {
  version: string;
  buildMtimeMs: number;
  stateRoot: string;
  config: SquadrantConfig;
  driver: DaemonRestartNotifyDriver;
  appendCaptainMessage: AppendCaptainMessageFn;
}

/**
 * Boot-time entry point: compare this boot's (version, buildMtime) signature
 * against the last persisted one. Differs → broadcast + persist. Same → stay
 * silent (e.g. launchd crash-restart of an identical build). Fully
 * best-effort — never throws, so it can never block or crash daemon boot.
 */
export async function maybeBroadcastDaemonRestart(opts: MaybeBroadcastDaemonRestartOpts): Promise<void> {
  try {
    const { version, buildMtimeMs, stateRoot, config, driver, appendCaptainMessage } = opts;
    const signature = computeRestartSignature(version, buildMtimeMs);
    const previous = readPersistedRestartSignature(stateRoot);
    if (previous === signature) return;
    const isDevRebuild = previous !== null && previous.split("::")[0] === version;
    await notifyCaptainsOfDaemonRestart(version, config, driver, isDevRebuild, appendCaptainMessage);
    writePersistedRestartSignature(stateRoot, signature);
  } catch {
    // best-effort — never let a broadcast failure block or crash daemon boot
  }
}
