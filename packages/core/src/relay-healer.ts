// src/control/relay-healer.ts
//
// cmux-facing helper for the #207 relay-health layer, isolated behind the
// runtime driver (same pattern as crew-pane-reader.ts). Resolves the captain
// workspace via the runtime and NEVER throws — a flaky cmux probe must not
// trip the daemon sweep / health verb.
import { loadConfig } from "@cockpit/shared";
import type { RuntimeDriver, CockpitConfig } from "@cockpit/shared";
import type { RelayHealOutcome } from "./daemon.js";

// Inlined from relay-supervisor.ts (root stays there; core can't import it).
const RELAY_TAB_TITLE = "✉ notify-relay";
const RELAY_RESTART_DELAY_S = 3;
function buildRelayCmd(project: string): string {
  const relay = `cockpit notify-relay ${project} --as captain`;
  return (
    `while true; do ${relay}; ` +
    `echo "[notify-relay ${project}] exited (code $?), restarting in ${RELAY_RESTART_DELAY_S}s"; ` +
    `sleep ${RELAY_RESTART_DELAY_S}; done`
  );
}

/**
 * Best-effort relay heal (#207, SECONDARY). Re-spawns the notify-relay tab in
 * the captain workspace via the runtime's spawnInjector. This is mostly INERT in
 * production: cmux refuses calls from the launchd daemon (outside its
 * process-lineage), so the spawn is rejected and we just log. Genuine in-prod
 * recovery is captain-managed from inside the cmux tree (relay-keeper #224 was
 * reverted as over-complex); the never-silently-blind guarantee comes from the
 * liveness SURFACE, not this hook. Never throws.
 *
 * @param makeRuntime  Factory that returns a RuntimeDriver for the given project.
 *   Omit (or return null) to skip healing — used in test environments that have
 *   no runtime. The host (cockpitd.ts) always supplies this.
 */
export function createRelayHealer(
  log: (m: string) => void = () => {},
  makeRuntime?: (project: string, config: CockpitConfig) => RuntimeDriver | null,
): (project: string) => Promise<RelayHealOutcome> {
  return async (project) => {
    if (!makeRuntime) return "skipped";
    try {
      const config = loadConfig();
      const proj = config.projects[project];
      if (!proj) return "skipped";
      const runtime = makeRuntime(project, config);
      if (!runtime) return "skipped";
      const ws = await runtime.status(proj.captainName);
      if (!ws) {
        // Captain workspace gone for good — signal the sweep to prune this relay
        // record so this log fires ONCE, not every cycle (audit STEP 3).
        log(`relay heal ${project}: captain workspace not present; pruning stale relay record`);
        return "captain-absent";
      }
      // Dedup: close any pre-existing relay tab before respawning fresh.
      try {
        const surfaces = await runtime.listSurfaces(ws.id);
        for (const s of surfaces) {
          if (s.title === RELAY_TAB_TITLE) {
            try { await runtime.closePane(s); } catch { /* best effort */ }
          }
        }
      } catch { /* best effort */ }
      await runtime.spawnInjector({
        captainWorkspace: ws,
        command: buildRelayCmd(project),
        title: RELAY_TAB_TITLE,
        placement: "background",
      });
      log(`relay heal ${project}: re-spawned notify-relay tab`);
      return "healed";
    } catch (e) {
      // Expected under launchd (cmux lineage refusal). The surface still shows
      // the relay down with its actionable; this is the secondary path. Captain
      // workspace WAS resolvable here (status succeeded), so do not prune —
      // return "skipped" so the record stays and the surface keeps reporting it.
      log(`relay heal ${project} failed (expected under launchd lineage): ${(e as Error).message}`);
      return "skipped";
    }
  };
}
