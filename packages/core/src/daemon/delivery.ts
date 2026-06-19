// src/control/daemon/delivery.ts
// Mailbox notification + daemon-direct captain delivery loop (#332).
import { appendToMailbox, readCursor, writeCursor, readFromCursor } from "../mailbox.js";
import { CaptainDelivery } from "../delivery/captain-delivery.js";
import { loadConfig } from "@cockpit/shared";
import { STALE_THRESHOLD_MS } from "./interactive-probe.js";
import type { TaskRecord, ControlEvent } from "@cockpit/shared";
import type { PaneRef } from "@cockpit/shared";
import type { DaemonSurfaceDriver } from "../interfaces.js";
import type { DaemonContext } from "./context.js";

const CURSOR_SUBSCRIBER = "captain";
const CAPTAIN_GONE_STREAK_K = 3;

/** Pure: find the captain surface by title in a surface list (#332). */
export function discoverCaptainSurface(surfaces: PaneRef[], captainTitle: string): PaneRef | null {
  return surfaces.find((s) => s.title === captainTitle) ?? null;
}

export interface DeliveryResult {
  defaultNotify: (args: { project: string; message: string; record: TaskRecord; event: ControlEvent }) => Promise<void>;
  /** Guarded delivery tick — undefined when daemon-direct mode is OFF. */
  deliveryTick: (() => Promise<void>) | undefined;
}

export function createDelivery(
  ctx: DaemonContext,
  daemonCmux: DaemonSurfaceDriver | undefined,
): DeliveryResult {
  const { stateRoot, store, log, captainMissingStreak, stoppedProjects, opts } = ctx;

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
    return { defaultNotify, deliveryTick: undefined };
  }

  const cmux = daemonCmux;
  const cfg = loadConfig();
  const deliveries = new Map<string, CaptainDelivery>();
  // Captured once at delivery-loop setup. Entries older than
  // sessionStartMs - STALE_THRESHOLD_MS are silently acked (cursor advanced)
  // without delivery. This stops a fresh/empty cursor from re-delivering the
  // entire historical backlog.
  const sessionStartMs = Date.now();

  // Re-entrancy guard: each tick does multiple slow cmux subprocess calls and
  // can exceed the 1s interval.
  let delivering = false;

  const deliveryCore = async () => {
    const injectedSurfaces = opts.captainSurfaces ?? {};
    const allProjects = [...new Set([
      ...Object.keys(cfg.projects ?? {}),
      ...Object.keys(injectedSurfaces),
      ...store.listAll().map((t) => t.project),
    ])];

    for (const project of allProjects) {
      const projCfg = cfg.projects?.[project];
      const captainTitle = projCfg?.captainName ?? `${project}-captain`;

      // Try real discovery from cmux.
      const wsId = cmux.findWorkspaceId ? await cmux.findWorkspaceId(captainTitle) : null;
      let surface: PaneRef | null = null;
      let surfacesLength = 0;

      if (wsId) {
        const surfaces = await cmux.listSurfaces(wsId);
        surfacesLength = surfaces.length;
        surface = discoverCaptainSurface(surfaces, captainTitle);
      }

      // Fall back to injected surface (tests / config-less projects).
      if (!surface) surface = injectedSurfaces[project] ?? null;

      if (surface) {
        // Captain found — if previously reaped, un-reap and reset streak.
        if (stoppedProjects.has(project)) {
          stoppedProjects.delete(project);
          captainMissingStreak.set(project, 0);
        }
        captainMissingStreak.set(project, 0);
      } else {
        // Streak tracking: surfaces.length > 0 means cmux is reachable but the
        // captain's pane is provably absent. surfaces.length === 0 means cmux
        // was unreachable (fail-soft → []), treat as "unknown" — never increment.
        if (surfacesLength > 0) {
          const streak = (captainMissingStreak.get(project) ?? 0) + 1;
          captainMissingStreak.set(project, streak);
          if (streak >= CAPTAIN_GONE_STREAK_K) {
            if (!stoppedProjects.has(project)) {
              stoppedProjects.add(project);
              log(`captain ${captainTitle}: surface gone for ${CAPTAIN_GONE_STREAK_K} sweeps — stopping delivery`);
            }
          }
        }
        continue;
      }

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
          await writeCursor({ stateRoot, project, subscriber: CURSOR_SUBSCRIBER, lastAckedSeq: entry.seq });
          continue;
        }
        const result = await d.deliver(entry, (text, sendOpts) =>
          cmux.send(surface!, text, sendOpts),
        );
        if ("delivered" in result) {
          await writeCursor({ stateRoot, project, subscriber: CURSOR_SUBSCRIBER, lastAckedSeq: entry.seq });
        } else {
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

  return { defaultNotify, deliveryTick };
}
