// src/control/relay-healer.ts
//
// cmux-facing helper for the #207 relay-health layer, isolated behind the
// runtime driver (same pattern as crew-pane-reader.ts). Resolves the captain
// workspace via the runtime and NEVER throws — a flaky cmux probe must not
// trip the daemon sweep / health verb.
import { loadConfig } from "@cockpit/shared";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import { buildRelaySupervisorCommand, NOTIFY_RELAY_TAB_TITLE } from "./relay-supervisor.js";
import type { RelayHealOutcome } from "./daemon.js";

/**
 * Best-effort relay heal (#207, SECONDARY). Re-spawns the notify-relay tab in
 * the captain workspace via the runtime's spawnInjector. This is mostly INERT in
 * production: cmux refuses calls from the launchd daemon (outside its
 * process-lineage), so the spawn is rejected and we just log. Genuine in-prod
 * recovery is captain-managed from inside the cmux tree (relay-keeper #224 was
 * reverted as over-complex); the never-silently-blind guarantee comes from the
 * liveness SURFACE, not this hook. Never throws.
 */
export function createRelayHealer(
  log: (m: string) => void = () => {},
): (project: string) => Promise<RelayHealOutcome> {
  return async (project) => {
    try {
      const config = loadConfig();
      const proj = config.projects[project];
      if (!proj) return "skipped";
      const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(project, config);
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
          if (s.title === NOTIFY_RELAY_TAB_TITLE) {
            try { await runtime.closePane(s); } catch { /* best effort */ }
          }
        }
      } catch { /* best effort */ }
      await runtime.spawnInjector({
        captainWorkspace: ws,
        command: buildRelaySupervisorCommand(project),
        title: NOTIFY_RELAY_TAB_TITLE,
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
