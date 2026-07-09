// src/control/daemon/delivery.ts
// Mailbox notification + daemon-direct captain delivery loop (#332).
import { appendToMailbox, readCursor, writeCursor, readFromCursor } from "../mailbox.js";
import { CaptainDelivery, type CaptainDeliveryStats } from "../delivery/captain-delivery.js";
import { loadConfig, TERMINAL_STATES } from "@squadrant/shared";
import { STALE_THRESHOLD_MS } from "./interactive-probe.js";
import { deriveCaptainState } from "../liveness.js";
import type { TaskRecord, ControlEvent, RuntimeLivenessRecord, LivenessEntry } from "@squadrant/shared";
import type { PaneRef } from "@squadrant/shared";
import type { Store } from "../store.js";
import type { DaemonSurfaceDriver } from "../interfaces.js";
import type { DaemonContext } from "./context.js";
import type { LivenessRegistry } from "./liveness-registry.js";

const CURSOR_SUBSCRIBER = "captain";

// Must-deliver event kinds that bypass the stale-skip path (#474 D1).
// Includes terminal transitions (done/failed/cancelled) AND task.blocked:
// a dropped task.blocked leaves the captain waiting forever on a crew question.
const TERMINAL_KINDS = new Set(["task.done", "task.failed", "task.cancelled", "task.blocked"]);

/** Pure: find the captain surface by title in a surface list (#332). */
export function discoverCaptainSurface(surfaces: PaneRef[], captainTitle: string): PaneRef | null {
  return surfaces.find((s) => s.title === captainTitle) ?? null;
}

/**
 * Reap a stopped project's orphaned crews (#324). When the user closes the
 * captain workspace, its crew panes die with it — every non-terminal
 * interactive crew is orphaned. Terminalize them to 'cancelled' with a distinct
 * `captain-stopped` marker (traceable; not a fault). Silent: no push fires (the
 * captain that would receive it is gone). Returns the count reaped.
 *
 * Headless crews are excluded — they run as detached processes, not panes in the
 * captain's workspace, and are reconciled by their own pid liveness instead.
 */
export function reapOrphanedCrews(store: Pick<Store, "list" | "put">, project: string): number {
  let reaped = 0;
  for (const r of store.list(project)) {
    if (TERMINAL_STATES.has(r.state)) continue;
    if (r.mode !== "interactive") continue;
    store.put({ ...r, state: "cancelled", lastEvent: "captain-stopped" });
    reaped++;
  }
  return reaped;
}

export interface LivenessTickDeps {
  registry: LivenessRegistry;
  liveness: () => Promise<RuntimeLivenessRecord[]>;
  isPidAlive: (pid: number) => boolean;
  now: () => number;
  /** Reap a stopped/gone captain's orphaned crews (#324 — fold-in of the old
   *  streak-triggered reap, now driven by the registry). Optional so pure
   *  liveness-only callers can omit it. Idempotent (already-terminal crews are
   *  skipped), so calling it every tick for a non-alive captain is safe. */
  reap?: (project: string) => number;
  /** One grep-able line per applied/transitioned record (§4.4): `[role/source]
   *  project pid=… → state`. Optional so pure liveness-only callers can omit it. */
  log?: (msg: string) => void;
}

function logEntry(log: ((msg: string) => void) | undefined, project: string, e: LivenessEntry | undefined): void {
  if (!log || !e) return;
  log(`[${e.role}/${e.source}] ${project} pid=${e.pid} → ${deriveCaptainState(e)}`);
}

/** One reconcile+floor pass over captain records. Runtime snapshot is authoritative;
 *  the pid floor arbitrates liveness; a captain absent from the snapshot is marked
 *  cleanly-closed (stopped) but NOT dropped. */
export async function runLivenessTick(deps: LivenessTickDeps): Promise<void> {
  const now = deps.now();
  let records: RuntimeLivenessRecord[] = [];
  try { records = await deps.liveness(); } catch { return; } // runtime unreachable → leave registry as-is
  const seen = new Set<string>();

  // #527: multiple cmux sessions can share a cwd, producing duplicate project
  // entries. Group by project and pick one winner to avoid last-write-wins
  // collision (dead pid overwriting live).
  const byProject = new Map<string, RuntimeLivenessRecord[]>();
  for (const r of records) {
    if (r.role !== "captain") continue;
    let arr = byProject.get(r.project);
    if (!arr) { arr = []; byProject.set(r.project, arr); }
    arr.push(r);
  }

  for (const [project, recs] of byProject) {
    seen.add(project);
    // Prefer pidAlive===true (or pid:null hibernated), then first in order.
    const winner = recs.find(r => r.pid == null || deps.isPidAlive(r.pid)) ?? recs[0];
    const entry: LivenessEntry = {
      project, role: "captain", pid: winner.pid, sessionId: winner.sessionId,
      startedAt: now, lastState: "start", lastSeenAt: now,
      pidAlive: winner.pid != null ? deps.isPidAlive(winner.pid) : true,
      source: "runtime",
    };
    // Preserve original startedAt if we already knew this captain (avoid churn):
    const prev = deps.registry.get(project);
    if (prev && prev.lastState === "start") entry.startedAt = prev.startedAt;
    deps.registry.apply(entry);
    if (winner.pid != null) deps.registry.setPidAlive(project, deps.isPidAlive(winner.pid), now);
    logEntry(deps.log, project, deps.registry.get(project));
  }

  // Captains we knew but the snapshot no longer lists → clean close.
  for (const e of deps.registry.all()) {
    if (e.role === "captain" && e.lastState === "start" && !seen.has(e.project)) {
      deps.registry.markEnded(e.project, now);
      logEntry(deps.log, e.project, deps.registry.get(e.project));
    }
  }

  // Reap orphaned crews for any captain the registry now considers stopped
  // (clean close) or gone (crash).
  if (deps.reap) {
    for (const e of deps.registry.all()) {
      if (e.role !== "captain") continue;
      const state = deriveCaptainState(e);
      if (state === "stopped" || state === "gone") deps.reap(e.project);
    }
  }
}

export interface DeliveryResult {
  defaultNotify: (args: { project: string; message: string; record: TaskRecord; event: ControlEvent }) => Promise<void>;
  /** Guarded delivery tick — undefined when daemon-direct mode is OFF. */
  deliveryTick: (() => Promise<void>) | undefined;
  /** Read-only per-project deferral stats (B1). undefined when daemon-direct mode is OFF,
   *  or when the project has no CaptainDelivery instance yet (no delivery attempted). */
  deliveryStats: (project: string) => CaptainDeliveryStats | undefined;
}

export function createDelivery(
  ctx: DaemonContext,
  daemonCmux: DaemonSurfaceDriver | undefined,
): DeliveryResult {
  const { stateRoot, store, log, livenessRegistry, isPidAlive, opts } = ctx;

  // ── Default push-notification wiring (mailbox-injector spec) ─────────────
  const defaultNotify = async (args: {
    project: string;
    message: string;
    record: TaskRecord;
    event: ControlEvent;
  }): Promise<void> => {
    try {
      await appendToMailbox({
        stateRoot,
        project: args.project,
        taskRecord: args.record,
        event: args.event,
        // Persist the daemon-rendered message (#214/#210): delivered verbatim
        // rather than re-derived from the raw event (which drifted).
        message: args.message,
      });
    } catch (e) {
      log(`mailbox append failed project=${args.project}: ${(e as Error).message}`);
    }
  };

  // ── Daemon-direct delivery loop ───────────────────────────────────────────
  if (!daemonCmux) {
    return { defaultNotify, deliveryTick: undefined, deliveryStats: () => undefined };
  }

  const cmux = daemonCmux;
  const cfg = loadConfig();
  const deliveries = new Map<string, CaptainDelivery>();
  const deliveryStats = (project: string): CaptainDeliveryStats | undefined => deliveries.get(project)?.stats();
  // Captured once at delivery-loop setup. Entries older than
  // sessionStartMs - STALE_THRESHOLD_MS are silently acked (cursor advanced)
  // without delivery. This stops a fresh/empty cursor from re-delivering the
  // entire historical backlog.
  const sessionStartMs = Date.now();

  // Re-entrancy guard: each tick does multiple slow cmux subprocess calls and
  // can exceed the 1s interval.
  let delivering = false;

  const deliveryCore = async () => {
    // Registry is the liveness authority (Task 4) — reconcile it from the
    // runtime snapshot + pid floor before this tick's per-project pass.
    await runLivenessTick({
      registry: livenessRegistry,
      liveness: () => (cmux.liveness ? cmux.liveness() : Promise.resolve([])),
      isPidAlive,
      now: () => Date.now(),
      log,
      reap: (project) => {
        const reaped = reapOrphanedCrews(store, project);
        if (reaped > 0) {
          const title = cfg.projects?.[project]?.captainName ?? `${project}-captain`;
          log(`captain ${title}: reaped ${reaped} orphaned crew(s)`);
        }
        return reaped;
      },
    });

    const injectedSurfaces = opts.captainSurfaces ?? {};
    const allProjects = [...new Set([
      ...Object.keys(cfg.projects ?? {}),
      ...Object.keys(injectedSurfaces),
      ...store.listAll().map((t) => t.project),
    ])];

    for (const project of allProjects) {
      const projCfg = cfg.projects?.[project];
      const captainTitle = projCfg?.captainName ?? `${project}-captain`;

      // Surface discovery is ONLY for the delivery target (where to cmux.send);
      // captain presence/liveness authority now lives in livenessRegistry.
      const wsId = cmux.findWorkspaceId ? await cmux.findWorkspaceId(captainTitle) : null;
      let surface: PaneRef | null = null;

      if (wsId) {
        const surfaces = await cmux.listSurfaces(wsId);
        surface = discoverCaptainSurface(surfaces, captainTitle);
      }

      // Fall back to injected surface (tests / config-less projects).
      if (!surface) surface = injectedSurfaces[project] ?? null;

      if (!surface) continue;

      const cursor = await readCursor({ stateRoot, project, subscriber: CURSOR_SUBSCRIBER });
      const lastAcked = cursor?.lastAckedSeq ?? 0;
      let d = deliveries.get(project);
      if (!d) {
        d = new CaptainDelivery({
          maxDefers: cfg.delivery?.maxDeferDeliveries ?? 300,
          stableProbePolls: cfg.delivery?.stableProbePolls ?? 3,
        });
        deliveries.set(project, d);
      }
      for await (const entry of readFromCursor({ stateRoot, project, fromSeq: lastAcked + 1 })) {
        // #332 storm BUG 3: silently ack entries that pre-date this daemon
        // session by more than STALE_THRESHOLD_MS.
        if (new Date(entry.ts).getTime() < sessionStartMs - STALE_THRESHOLD_MS) {
          // D1 (#474): terminal events must deliver regardless of age — an
          // undelivered CREW DONE must reach the captain even after a daemon
          // restart >5min after enqueue. Non-terminal backlog suppression stays.
          if (!TERMINAL_KINDS.has(entry.kind)) {
            log(`delivery seq=${entry.seq} kind=${entry.kind} outcome=stale-skipped`);
            await writeCursor({ stateRoot, project, subscriber: CURSOR_SUBSCRIBER, lastAckedSeq: entry.seq });
            continue;
          }
          log(`delivery seq=${entry.seq} kind=${entry.kind} outcome=stale-terminal-deliver`);
        }
        const result = await d.deliver(entry, (text, sendOpts) =>
          cmux.send(surface!, text, sendOpts),
        );
        if ("delivered" in result) {
          log(`delivery seq=${entry.seq} kind=${entry.kind} outcome=delivered`);
          await writeCursor({ stateRoot, project, subscriber: CURSOR_SUBSCRIBER, lastAckedSeq: entry.seq });
        } else {
          log(`delivery seq=${entry.seq} kind=${entry.kind} outcome=deferred`);
          break;
        }
      }
    }
  };

  const deliveryTick = async () => {
    if (delivering) return;
    delivering = true;
    try {
      await deliveryCore();
    } finally {
      delivering = false;
    }
  };

  return { defaultNotify, deliveryTick, deliveryStats };
}
