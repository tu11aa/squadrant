// src/control/daemon/probes.ts
// Surface-liveness probe logic for the daemon-direct delivery path.
// Two probes:
//   proxiedSurfaceAlive — relay-proxy path (#239 Phase B)
//   buildInteractiveProbe — daemon-direct blocked-crew detection (#332)
import { createInteractiveProbe } from "./interactive-probe.js";
import { createDirectCrewPaneReader, createDirectSurfaceLivenessProbe } from "../crew-pane-reader.js";
import { loadConfig } from "@cockpit/shared";
import type { TaskRecord } from "@cockpit/shared";
import type { DaemonSurfaceDriver } from "../interfaces.js";
import type { DaemonContext } from "./context.js";

export interface ProbeHandlers {
  /** Relay-proxy probe path: enqueue + cache liveness for interactive tasks. */
  proxiedSurfaceAlive: (rec: TaskRecord) => Promise<"alive" | "gone" | "unknown">;
  /** Build the probe-tick function for the daemon-direct delivery loop.
   *  Call once after the surface driver is resolved; returns a guarded tick. */
  buildInteractiveProbe: (deps: { cmux: DaemonSurfaceDriver }) => () => Promise<void>;
  /** Direct-cmux surface liveness probe (replaces proxiedSurfaceAlive in daemon-direct mode). */
  directSurfaceProbe: (rec: TaskRecord) => Promise<"alive" | "gone" | "unknown">;
}

/** Resolve the captain pane name for a project from the config. */
function captainNameForProject(project: string): string {
  const cfg = loadConfig();
  return cfg.projects?.[project]?.captainName ?? `${project}-captain`;
}

export function createProbes(ctx: DaemonContext): ProbeHandlers {
  const { pendingProbes, probeResults, inFlightProbes, store, log } = ctx;

  // ── Relay-proxy surface-liveness probe (#239 Phase B) ────────────────────
  // The relay (running inside the captain's cmux tree) polls relay-proxy-poll
  // each tick, executes each probe in-lineage, and posts results back.
  const proxiedSurfaceAlive = async (rec: TaskRecord): Promise<"alive" | "gone" | "unknown"> => {
    if (rec.mode !== "interactive" || !rec.name) return "unknown";
    // Don't re-enqueue a probe that's already in-flight with the relay.
    if (inFlightProbes.has(rec.id)) return probeResults.get(rec.id) ?? "unknown";
    const list = pendingProbes.get(rec.project) ?? [];
    // Dedup: only enqueue once per taskId until the relay drains the queue.
    if (!list.some((p) => p.taskId === rec.id)) {
      list.push({ taskId: rec.id, name: rec.name });
      pendingProbes.set(rec.project, list);
    }
    return probeResults.get(rec.id) ?? "unknown";
  };

  // ── Daemon-direct: direct cmux surface probe (replaces proxied in #332 mode) ─
  const directSurfaceProbe = (rec: TaskRecord): Promise<"alive" | "gone" | "unknown"> => {
    // Will be filled with a real implementation when buildInteractiveProbe is
    // called with the resolved cmux. Until then, fall back to proxied path.
    return proxiedSurfaceAlive(rec);
  };

  // ── Daemon-direct: blocked-crew detection (#332) ──────────────────────────
  // Reuses createInteractiveProbe (from notify-relay.ts) with a direct cmux
  // pane reader injected as the readPaneTail dep. The returned tick function
  // must be called from within the delivery loop's interval.
  function buildInteractiveProbe(deps: { cmux: DaemonSurfaceDriver }): () => Promise<void> {
    const directPaneReader = createDirectCrewPaneReader(deps.cmux, captainNameForProject);
    const probe = createInteractiveProbe({
      project: "_all_",
      listTasks: async () => store.listAll(),
      readPaneTail: directPaneReader,
      sendEvent: async (event) => {
        const rec = store.listAll().find((r) => r.id === event.id);
        if (rec) {
          // ctx.d is late-bound — populated by start.ts before any tick fires.
          await ctx.d.handle({ kind: "event", project: rec.project, event });
        }
      },
      now: () => Date.now(),
      log,
    });
    // Guard against overlapping ticks (cmux reads can be slow).
    let probing = false;
    return async () => {
      if (probing) return;
      probing = true;
      try { await probe.tick(); }
      finally { probing = false; }
    };
  }

  return { proxiedSurfaceAlive, buildInteractiveProbe, directSurfaceProbe };
}

/** Build the surface-liveness probe used by createDaemon — selects direct or
 *  proxied path based on the daemon-direct flag. Pure: no side effects. */
export function buildSurfaceProbe(
  ctx: DaemonContext,
  probes: ProbeHandlers,
  daemonDirectCmux: boolean,
  daemonCmux: DaemonSurfaceDriver | undefined,
): (rec: TaskRecord) => Promise<"alive" | "gone" | "unknown"> {
  if (ctx.opts.isSurfaceAlive) return ctx.opts.isSurfaceAlive;
  if (daemonDirectCmux && daemonCmux) {
    return createDirectSurfaceLivenessProbe(daemonCmux, captainNameForProject);
  }
  return probes.proxiedSurfaceAlive;
}
