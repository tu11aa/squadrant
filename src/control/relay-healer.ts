// src/control/relay-healer.ts
//
// cmux-facing helpers for the #207 relay-health layer, isolated behind the
// runtime driver (same pattern as crew-pane-reader.ts). Both functions resolve
// the captain workspace via the runtime and NEVER throw — a flaky cmux probe
// must not trip the daemon sweep / health verb.
import { loadConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import { buildRelaySupervisorCommand, NOTIFY_RELAY_TAB_TITLE } from "./relay-supervisor.js";

/**
 * Resolve whether a project's captain workspace is currently present.
 *   true  → workspace running
 *   false → enumerated, absent
 *   null  → could not determine (cmux down, no project) — never alarms
 * NOTE: cmux lineage enforcement blocks ALL daemon-originated cmux calls
 * (reads included — see #224 revert), so from the launchd daemon this resolves
 * null in prod. It still works from a cmux-resident caller; the #139 surface
 * probe relies on the same primitive.
 */
export function createCaptainProbe(): (project: string, captainName: string) => Promise<boolean | null> {
  return async (project, captainName) => {
    try {
      const config = loadConfig();
      if (!config.projects[project]) return null;
      const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(project, config);
      const ws = await runtime.status(captainName);
      return ws != null;
    } catch {
      return null;
    }
  };
}

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
): (project: string) => Promise<void> {
  return async (project) => {
    try {
      const config = loadConfig();
      const proj = config.projects[project];
      if (!proj) return;
      const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(project, config);
      const ws = await runtime.status(proj.captainName);
      if (!ws) {
        log(`relay heal ${project}: captain workspace not present; nothing to heal into`);
        return;
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
    } catch (e) {
      // Expected under launchd (cmux lineage refusal). The surface still shows
      // the relay down with its actionable; this is the secondary path.
      log(`relay heal ${project} failed (expected under launchd lineage): ${(e as Error).message}`);
    }
  };
}
