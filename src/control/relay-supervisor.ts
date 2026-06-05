// src/control/relay-supervisor.ts
//
// Pure builders for the notify-relay tab — extracted from launch.ts so both the
// launcher (in-cmux) and the daemon's best-effort relay healer (#207) can share
// them without the daemon importing launch.ts's heavy driver/workspace graph.

export const NOTIFY_RELAY_TAB_TITLE = "✉ notify-relay";

const RELAY_RESTART_DELAY_S = 3;

/**
 * Build the command for the relay tab as a self-restarting shell supervisor
 * loop (#186). The relay process can exit on its own — most commonly a boot
 * race during a daemon/session restart, where `runNotifyRelay` throws "captain
 * workspace 'X' not running" and the CLI does `process.exit(1)`. With a bare
 * `cockpit notify-relay …` invocation it then stays dead, and the captain is
 * silently blind to every CREW BLOCKED/DONE event (the documented 2026-05-31
 * failure). Wrapping it in `while true; do …; sleep N; done` makes any exit
 * respawn the relay — and rides out the boot race until the captain workspace
 * appears. The loop is typed into the tab's shell by spawnInjector, so the cmux
 * tab is the supervisor; this needs no daemon (which can't spawn into cmux) and
 * no captain-side hook (cmux owns the captain's settings).
 */
export function buildRelaySupervisorCommand(project: string): string {
  const relay = `cockpit notify-relay ${project} --as captain`;
  return (
    `while true; do ${relay}; ` +
    `echo "[notify-relay ${project}] exited (code $?), restarting in ${RELAY_RESTART_DELAY_S}s"; ` +
    `sleep ${RELAY_RESTART_DELAY_S}; done`
  );
}
