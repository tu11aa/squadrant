// Best-effort "daemon restarted" broadcast to all running captains, fired on
// daemon boot — but only when the running build actually changed (version or
// local rebuild), not on a same-build launchd crash-restart. Modeled exactly
// on notifyCaptainsOfEffort (commands/effort.ts): same driver seam, same
// best-effort/never-throw contract.
import fs from "node:fs";
import path from "node:path";
import type { SquadrantConfig } from "@squadrant/shared";

/** Minimal slice of RuntimeDriver used to notify a captain. */
export interface DaemonRestartNotifyDriver {
  status(nameOrId: string): Promise<{ id: string } | null>;
  send(ref: string, message: string): Promise<void>;
}

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
 * Send the daemon-restart notice to every running captain. Unlike
 * notifyCaptainsOfEffort there is no initiating cwd captain to exclude — the
 * daemon boots independently of any captain — so this reaches ALL of them.
 */
export async function notifyCaptainsOfDaemonRestart(
  version: string,
  config: SquadrantConfig,
  driver: DaemonRestartNotifyDriver,
  isDevRebuild = false,
): Promise<void> {
  const notice = restartNotice(version, isDevRebuild);
  for (const [, proj] of Object.entries(config.projects)) {
    try {
      const ref = await driver.status(proj.captainName);
      if (ref) {
        await driver.send(ref.id, notice);
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
}

/**
 * Boot-time entry point: compare this boot's (version, buildMtime) signature
 * against the last persisted one. Differs → broadcast + persist. Same → stay
 * silent (e.g. launchd crash-restart of an identical build). Fully
 * best-effort — never throws, so it can never block or crash daemon boot.
 */
export async function maybeBroadcastDaemonRestart(opts: MaybeBroadcastDaemonRestartOpts): Promise<void> {
  try {
    const { version, buildMtimeMs, stateRoot, config, driver } = opts;
    const signature = computeRestartSignature(version, buildMtimeMs);
    const previous = readPersistedRestartSignature(stateRoot);
    if (previous === signature) return;
    const isDevRebuild = previous !== null && previous.split("::")[0] === version;
    await notifyCaptainsOfDaemonRestart(version, config, driver, isDevRebuild);
    writePersistedRestartSignature(stateRoot, signature);
  } catch {
    // best-effort — never let a broadcast failure block or crash daemon boot
  }
}
