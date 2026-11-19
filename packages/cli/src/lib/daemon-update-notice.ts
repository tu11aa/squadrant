// Daemon-side update push (#1150): once per version, tell live captains about an
// IMPORTANT release (or one that makes this install fall below minSafe), through the
// same mailbox path as the daemon-restart broadcast so the delivery loop drains it with
// draft protection. Reuses checkForUpdate (shared cache + opt-outs). Best-effort: never
// throws, never blocks daemon boot.
import path from "node:path";
import {
  type SquadrantConfig,
  readConfigFileSync,
  writeConfigFileSync,
  checkForUpdate,
  isUpdateCheckDisabled,
  isNewerVersion,
  isBelowMinSafe,
  readUpdateCheckState,
  writeUpdateCheckState,
  type UpdateCheckState,
  type RegistryRequest,
} from "@squadrant/shared";
import { notifyCaptainsOfDaemonRestart, type AppendCaptainMessageFn, type DaemonRestartNotifyDriver } from "./daemon-restart-broadcast.js";

/** How often the daemon re-evaluates; checkForUpdate's own 24h cache gates the network. */
export const UPDATE_TICK_MS = 6 * 60 * 60 * 1000;

function notifiedPath(stateRoot: string): string {
  return path.join(stateRoot, "update-notified.json");
}

export function readNotifiedVersion(stateRoot: string): string | null {
  try {
    const v = (JSON.parse(readConfigFileSync(notifiedPath(stateRoot))) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Pure: does this cached state warrant pushing to captains? */
export function shouldPushUpdate(state: UpdateCheckState | undefined, current: string): boolean {
  const latest = state?.latestKnown;
  if (!latest || !isNewerVersion(latest, current)) return false;
  return state.level === "important" || isBelowMinSafe(current, state.minSafe);
}

export interface DaemonUpdateCheckOpts {
  version: string;
  stateRoot: string;
  config: SquadrantConfig;
  driver: DaemonRestartNotifyDriver;
  appendCaptainMessage: AppendCaptainMessageFn;
  fetchImpl?: RegistryRequest;
  statePath?: string;
  now?: () => number;
}

export async function runDaemonUpdateCheck(opts: DaemonUpdateCheckOpts): Promise<void> {
  try {
    if (isUpdateCheckDisabled(opts.config)) return;
    const now = (opts.now ?? Date.now)();
    const outcome = await checkForUpdate({
      currentVersion: opts.version,
      state: readUpdateCheckState(opts.statePath),
      now,
      fetchImpl: opts.fetchImpl,
    });
    if (outcome.newState) writeUpdateCheckState(outcome.newState, opts.statePath);
    const state = outcome.newState ?? readUpdateCheckState(opts.statePath);
    if (!outcome.notice || !shouldPushUpdate(state, opts.version)) return;
    if (readNotifiedVersion(opts.stateRoot) === state!.latestKnown) return;
    // Persist only once a captain was reached: the daemon can boot before any captain is up
    // (reboot), and that tick must not use up the notice. A crash between send and persist
    // may re-send once on the next tick; that is acceptable.
    const reached = await notifyCaptainsOfDaemonRestart(opts.version, opts.config, opts.driver, false, opts.appendCaptainMessage, outcome.notice);
    if (reached > 0) writeConfigFileSync(notifiedPath(opts.stateRoot), JSON.stringify({ version: state!.latestKnown }, null, 2) + "\n");
  } catch {
    // best-effort
  }
}
