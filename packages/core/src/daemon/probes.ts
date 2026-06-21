// src/control/daemon/probes.ts
// Surface-liveness probe logic for the daemon-direct delivery path.
import { createInteractiveProbe } from "./interactive-probe.js";
import { createDirectCrewPaneReader, createDirectSurfaceLivenessProbe } from "../crew-pane-reader.js";
import { loadConfig } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";
import type { DaemonSurfaceDriver } from "../interfaces.js";
import type { DaemonContext } from "./context.js";

export interface ProbeHandlers {
  /** Build the probe-tick function for the daemon-direct delivery loop.
   *  Call once after the surface driver is resolved; returns a guarded tick. */
  buildInteractiveProbe: (deps: { cmux: DaemonSurfaceDriver }) => () => Promise<void>;
  /** Direct-cmux surface liveness probe for interactive task reaping. */
  directSurfaceProbe: (rec: TaskRecord) => Promise<"alive" | "gone" | "unknown">;
}

/** Resolve the captain pane name for a project from the config. */
function captainNameForProject(project: string): string {
  const cfg = loadConfig();
  return cfg.projects?.[project]?.captainName ?? `${project}-captain`;
}

export function createProbes(ctx: DaemonContext): ProbeHandlers {
  const { store, log } = ctx;

  // ── Daemon-direct: direct cmux surface probe ──────────────────────────────
  const directSurfaceProbe = (_rec: TaskRecord): Promise<"alive" | "gone" | "unknown"> => {
    return Promise.resolve("unknown");
  };

  // ── Daemon-direct: blocked-crew detection ─────────────────────────────────
  // Reuses createInteractiveProbe with a direct cmux pane reader injected as
  // the readPaneTail dep. The returned tick must be called from the delivery
  // loop's interval.
  function buildInteractiveProbe(deps: { cmux: DaemonSurfaceDriver }): () => Promise<void> {
    const directPaneReader = createDirectCrewPaneReader(deps.cmux, captainNameForProject);
    const probe = createInteractiveProbe({
      project: "_all_",
      listTasks: async () => store.listAll(),
      readPaneTail: directPaneReader,
      sendEvent: async (event) => {
        const rec = store.listAll().find((r) => r.id === event.id);
        if (rec) {
          await ctx.d.handle({ kind: "event", project: rec.project, event });
        }
      },
      now: () => Date.now(),
      log,
    });
    let probing = false;
    return async () => {
      if (probing) return;
      probing = true;
      try { await probe.tick(); }
      finally { probing = false; }
    };
  }

  return { buildInteractiveProbe, directSurfaceProbe };
}

/** Build the surface-liveness probe used by createDaemon — always uses the
 *  direct cmux path when a driver is available. Pure: no side effects. */
export function buildSurfaceProbe(
  ctx: DaemonContext,
  probes: ProbeHandlers,
  daemonCmux: DaemonSurfaceDriver | undefined,
): (rec: TaskRecord) => Promise<"alive" | "gone" | "unknown"> {
  if (ctx.opts.isSurfaceAlive) return ctx.opts.isSurfaceAlive;
  if (daemonCmux) {
    return createDirectSurfaceLivenessProbe(daemonCmux, captainNameForProject);
  }
  return probes.directSurfaceProbe;
}
