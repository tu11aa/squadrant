// Restart attribution: every CLI path that restarts, reregisters or kickstarts
// the launchd daemon appends one line to the daemon log BEFORE acting, so the
// daemon's own `exit ... reason=SIGTERM` / `boot` / `previous exit` lines can be
// matched to the process that caused them (the daemon itself only ever sees a
// SIGTERM from launchd — it cannot know who asked for it).
import { appendFileSync, mkdirSync } from "node:fs";
import { daemonLogPath, logsRoot } from "@squadrant/shared";

export interface RestartTriggerProc {
  pid: number;
  ppid: number;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}

/** Pure: the one-line attribution record. `action` is what is about to happen, `reason` why. */
export function formatRestartTrigger(
  action: string,
  reason: string,
  proc: RestartTriggerProc = { pid: process.pid, ppid: process.ppid, argv: process.argv, env: process.env },
  now: Date = new Date(),
): string {
  const q = (s: string) => JSON.stringify(s);
  return (
    `[squadrant-cli] ${now.toISOString()} restart-trigger action=${action} reason=${q(reason)} ` +
    `pid=${proc.pid} ppid=${proc.ppid} argv=${q(proc.argv.slice(2, 4).join(" "))} ` +
    `role=${proc.env.SQUADRANT_ROLE || "-"} crewTask=${proc.env.SQUADRANT_CREW_TASK_ID || "-"} ` +
    `install=${proc.argv[1] ?? "-"}\n`
  );
}

/** Best-effort append to the daemon log; never throws (attribution must not block the action). */
export function logRestartTrigger(action: string, reason: string): void {
  try {
    mkdirSync(logsRoot(), { recursive: true });
    appendFileSync(daemonLogPath(), formatRestartTrigger(action, reason));
  } catch { /* best-effort */ }
}
