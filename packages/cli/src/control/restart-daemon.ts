import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LABEL, kickstartArgv, tryAcquireDaemonLock, releaseDaemonLock } from "@squadrant/core";

export type RestartOutcome = "restarted" | "skipped-not-running" | "skipped-opt-out";

const DEFAULT_SOCK_PATH = join(homedir(), ".config", "squadrant", "squadrant.sock");

function defaultIsRunning(): boolean {
  return existsSync(DEFAULT_SOCK_PATH);
}

function defaultRunKickstart(): void {
  const uid = process.getuid?.() ?? 0;
  const target = `gui/${uid}/${LABEL}`;
  if (tryAcquireDaemonLock()) {
    try {
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
  runKickstart?: () => void;
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
  runKickstart();
  return "restarted";
}
