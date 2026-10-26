import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LABEL, kickstartArgv, tryAcquireDaemonLock, releaseDaemonLock } from "./launchd.js";
import { logRestartTrigger } from "./restart-trigger.js";

export type RestartOutcome = "reloaded" | "restarted" | "skipped-not-running" | "skipped-opt-out";

import { DAEMON_SOCK_PATH } from "@squadrant/shared";
import { sendRequest } from "./protocol.js";

function defaultIsRunning(): boolean {
  return existsSync(DAEMON_SOCK_PATH);
}

function defaultRunKickstart(reason: string): void {
  const uid = process.getuid?.() ?? 0;
  const target = `gui/${uid}/${LABEL}`;
  if (tryAcquireDaemonLock()) {
    try {
      logRestartTrigger("kickstart-k", reason);
      execFileSync("launchctl", kickstartArgv(target, true), { stdio: "ignore" });
    } finally {
      releaseDaemonLock();
    }
  }
}

export function restartDaemonIfRunning(opts: {
  reason: string;
  noRestart?: boolean;
  isRunning?: () => boolean;
  runKickstart?: (reason: string) => void;
  env?: NodeJS.ProcessEnv;
  log?: (m: string) => void;
}): RestartOutcome {
  const env = opts.env ?? process.env;
  if (env["VITEST"] || opts.noRestart) return "skipped-opt-out";

  const isRunning = opts.isRunning ?? defaultIsRunning;
  if (!isRunning()) return "skipped-not-running";

  const log = opts.log ?? console.log;
  log(`↻ restarting daemon to apply ${opts.reason}…`);
  const runKickstart = opts.runKickstart ?? defaultRunKickstart;
  runKickstart(opts.reason);
  return "restarted";
}

/**
 * Apply a config write to a running daemon. When the change is live-reloadable
 * the daemon re-reads config over its socket (`config-reload`) and nothing
 * restarts; otherwise — or if the reload fails — fall back to a restart, with
 * the reason logged by the restart-attribution trail.
 */
export async function reloadOrRestartDaemon(opts: {
  reason: string;
  liveReloadable: boolean;
  noRestart?: boolean;
  isRunning?: () => boolean;
  reload?: () => Promise<unknown>;
  sockPath?: string;
  runKickstart?: (reason: string) => void;
  env?: NodeJS.ProcessEnv;
  log?: (m: string) => void;
}): Promise<RestartOutcome> {
  const env = opts.env ?? process.env;
  if (env["VITEST"] || opts.noRestart) return "skipped-opt-out";
  if (!(opts.isRunning ?? defaultIsRunning)()) return "skipped-not-running";

  const log = opts.log ?? console.log;
  if (opts.liveReloadable) {
    const reload = opts.reload ?? (() => sendRequest(opts.sockPath ?? DAEMON_SOCK_PATH, { kind: "config-reload", reason: opts.reason }));
    try {
      await reload();
      log(`↻ daemon reloaded config live (${opts.reason}) — no restart`);
      return "reloaded";
    } catch (e) {
      log(`daemon config reload failed (${(e as Error).message}) — falling back to restart`);
    }
  }
  return restartDaemonIfRunning({ ...opts, env, log, isRunning: () => true });
}
