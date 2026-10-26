import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LABEL, kickstartArgv, tryAcquireDaemonLock, releaseDaemonLock } from "./launchd.js";
import { logRestartTrigger } from "./restart-trigger.js";

export type RestartOutcome = "restarted" | "skipped-not-running" | "skipped-opt-out";

import { DAEMON_SOCK_PATH, isolatedConfigDir } from "@squadrant/shared";

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
  // #1046: an isolated SQUADRANT_CONFIG never kickstarts the launchd (production) daemon.
  if (isolatedConfigDir()) return "skipped-opt-out";

  const isRunning = opts.isRunning ?? defaultIsRunning;
  if (!isRunning()) return "skipped-not-running";

  const log = opts.log ?? console.log;
  log(`↻ restarting daemon to apply ${opts.reason}…`);
  const runKickstart = opts.runKickstart ?? defaultRunKickstart;
  runKickstart(opts.reason);
  return "restarted";
}
