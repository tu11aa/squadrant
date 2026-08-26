// src/control/daemon/delivery.ts
// Mailbox notification + daemon-direct captain delivery loop (#332).
import { appendToMailbox, appendCaptainMessage, readCursor, writeCursor, readFromCursor } from "../mailbox.js";
import { CaptainDelivery, type CaptainDeliveryStats, type DeliverDeferReason } from "../delivery/captain-delivery.js";
import { DeferDelivery } from "../delivery/defer-delivery.js";
import { loadConfig, TERMINAL_STATES } from "@squadrant/shared";
import { STALE_THRESHOLD_MS } from "./interactive-probe.js";
import { deriveCaptainState } from "../liveness.js";
import { deliverToCaptain } from "../captain-channel.js";
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

// #714: the DELIVERY STUCK alert must name the reason that actually fired —
// a binary modal-vs-everything-else text sent the operator hunting for a draft
// that never existed (the 2026-08-22 no-box jam pointed at an input box when
// the real cause was a destroyed surface). One distinct sentence per reason;
// "stable"/"unknown" have no operator action of their own, so they keep the
// generic retry-assurance wording.
const STUCK_ALERT_TEXT: Record<DeliverDeferReason, (n: number) => string> = {
  "no-box": (n) =>
    `⚠️ DELIVERY STUCK: your captain pane's input box could not be confirmed visible (an overlay, menu, or scrolled view may be covering it) and has blocked pending notification(s) for ${n}+ retries. This keeps retrying safely and will deliver automatically once the input box is visible again.`,
  modal: (n) =>
    `⚠️ DELIVERY STUCK: a modal question is open in your captain pane and has blocked pending notification(s) for ${n}+ retries. This keeps retrying safely and will deliver automatically once you answer or dismiss it.`,
  draft: (n) =>
    `⚠️ DELIVERY STUCK: an in-progress draft (or ghost text) in your input box has blocked pending notification(s) for ${n}+ retries. Your input is never touched — this keeps retrying safely and will deliver automatically once you submit or clear it.`,
  "probe-failed": (n) =>
    `⚠️ DELIVERY STUCK: reading your captain pane failed (stale/dead surface reference or cmux unavailable) and has blocked pending notification(s) for ${n}+ retries. Delivery re-resolves the pane automatically; if this persists after a captain restart, bounce the daemon to refresh its surface references.`,
  stable: (n) =>
    `⚠️ DELIVERY STUCK: pending notification(s) have been blocked for ${n}+ retries. This keeps retrying safely and will deliver automatically once the blocker clears.`,
  unknown: (n) =>
    `⚠️ DELIVERY STUCK: pending notification(s) have been blocked for ${n}+ retries. This keeps retrying safely and will deliver automatically once the blocker clears.`,
};

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
 *
 * #595: the caller only knows the CAPTAIN reads as stopped/gone — #697 showed
 * that liveness signal can false-positive on a captain that is still very much
 * alive and working. That is not proof the crew's own pane is gone too, so
 * this must never cancel on captain-liveness alone: only a crew whose own
 * surface is confirmed 'gone' is reaped. 'alive'/'unknown' (cmux down,
 * transient) fail safe and are left running — the invariant this issue exists
 * to restore is that a task record must never go terminal while its crew
 * surface is alive.
 */
export async function reapOrphanedCrews(
  store: Pick<Store, "list" | "put">,
  project: string,
  isSurfaceAlive: (rec: TaskRecord) => Promise<"alive" | "gone" | "unknown">,
): Promise<number> {
  let reaped = 0;
  for (const r of store.list(project)) {
    if (TERMINAL_STATES.has(r.state)) continue;
    if (r.mode !== "interactive") continue;
    const liveness = await isSurfaceAlive(r);
    if (liveness !== "gone") continue;
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
  reap?: (project: string) => number | Promise<number>;
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

  // #565: cmux's own store can degrade a session's launchCommand (observed live:
  // a crash/reattach left it as bare `["claude"]`, no --append-system-prompt-file)
  // so the record reads role:"unknown" even though it's the exact same session
  // already confirmed as this project's captain. SessionId identity outranks a
  // degraded launchCommand classification — restore "captain" for any record
  // whose sessionId matches an already-known captain for that project.
  const knownCaptainSessions = new Map<string, string>(); // sessionId → project
  for (const e of deps.registry.all()) {
    if (e.role === "captain") knownCaptainSessions.set(e.sessionId, e.project);
  }

  // #527: multiple cmux sessions can share a cwd, producing duplicate project
  // entries. Group by project and pick one winner to avoid last-write-wins
  // collision (dead pid overwriting live).
  const byProject = new Map<string, RuntimeLivenessRecord[]>();
  for (const r of records) {
    const role = r.role === "captain" || knownCaptainSessions.get(r.sessionId) === r.project
      ? "captain" : r.role;
    if (role !== "captain") continue;
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

  // Captains we knew but the snapshot no longer lists → clean close — but ONLY
  // with positive evidence the pid is actually dead (#565). Absence from a
  // single snapshot read is not proof of death (a store-file parsing glitch,
  // a degraded record, a transient cmux hiccup); inferring "ended" from
  // absence alone silently and permanently pauses delivery for a captain that
  // is still running. When the tracked pid can't be confirmed dead (still
  // alive, or unknown/null), leave the entry alone.
  for (const e of deps.registry.all()) {
    if (e.role !== "captain" || e.lastState !== "start" || seen.has(e.project)) continue;
    if (e.pid == null || deps.isPidAlive(e.pid)) {
      deps.log?.(`[${e.role}/runtime] ${e.project} pid=${e.pid} missing from snapshot but not confirmed dead — leaving alive`);
      continue;
    }
    deps.registry.markEnded(e.project, now);
    logEntry(deps.log, e.project, deps.registry.get(e.project));
  }

  // Reap orphaned crews for any captain the registry now considers stopped
  // (clean close) or gone (crash).
  if (deps.reap) {
    for (const e of deps.registry.all()) {
      if (e.role !== "captain") continue;
      const state = deriveCaptainState(e);
      if (state === "stopped" || state === "gone") await deps.reap(e.project);
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
  /** #589: the single most-deferred in-flight delivery across all projects right
   *  now, if any — embedded in the exit marker so a SIGTERM mid-jam is
   *  diagnosable (which project/seq/deferCount was stuck when the daemon died). */
  inFlightDelivery: () => { project: string; seq: number; deferCount: number } | null;
}

export function createDelivery(
  ctx: DaemonContext,
  daemonCmux: DaemonSurfaceDriver | undefined,
  /** #595: crew surface liveness probe, used to gate reapOrphanedCrews so a
   *  captain that merely reads as stopped/gone never terminalizes a crew whose
   *  own pane is still alive. Defaults to always-"unknown" (never reap) so
   *  callers that don't wire a real probe (tests) get the safe, inert default
   *  rather than the old unconditional-reap behavior. */
  isSurfaceAlive?: (rec: TaskRecord) => Promise<"alive" | "gone" | "unknown">,
): DeliveryResult {
  const { stateRoot, store, log, livenessRegistry, isPidAlive, opts, telegramBridge } = ctx;
  const surfaceProbe = isSurfaceAlive ?? (async () => "unknown" as const);
  // Default to a no-op so tests that construct a bare ctx object (not via
  // buildContext) don't need to inject this. squadrantd.ts always overrides
  // ctx.notifyFault with the real one in production (see context.ts).
  const notifyFault = ctx.notifyFault ?? (() => {});

  // ── Default push-notification wiring (mailbox-injector spec) ─────────────
  const defaultNotify = async (args: {
    project: string;
    message: string;
    record: TaskRecord;
    event: ControlEvent;
  }): Promise<void> => {
    // #594b: firePush decides to notify off a TaskRecord snapshot captured
    // synchronously at the state transition, but this mailbox write is
    // awaited I/O — a concurrent `crew close` (task.cancelled) can land on the
    // daemon's store in that gap and terminalize the SAME task. The reducer's
    // own terminal-absorb guard can't help here (the close is a separate,
    // later applyEvent call; this notify was already decided before it ran).
    // Re-check the daemon's own CURRENT record right before writing: if the
    // crew has since reached a terminal state different from what we're about
    // to announce, the notification is stale — the crew is gone — so drop it
    // rather than deliver e.g. "CREW IDLE" for a task that's already closed.
    // A terminal notification (CREW DONE/FAILED) always matches its own fresh
    // state and is unaffected; a missing record (e.g. purged) fails open.
    const fresh = store.get(args.project, args.record.id);
    if (fresh && TERMINAL_STATES.has(fresh.state) && fresh.state !== args.record.state) {
      return;
    }
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
    return { defaultNotify, deliveryTick: undefined, deliveryStats: () => undefined, inFlightDelivery: () => null };
  }

  const cmux = daemonCmux;
  const cfg = loadConfig();
  const deliveries = new Map<string, CaptainDelivery>();
  const deliveryStats = (project: string): CaptainDeliveryStats | undefined => deliveries.get(project)?.stats();
  // #589: last-known deferred entry per project, for the exit-marker snapshot.
  // Cleared on delivery; set/updated whenever a defer happens.
  const lastDeferred = new Map<string, { seq: number; deferCount: number }>();
  const inFlightDelivery = (): { project: string; seq: number; deferCount: number } | null => {
    let worst: { project: string; seq: number; deferCount: number } | null = null;
    for (const [project, v] of lastDeferred) {
      if (!worst || v.deferCount > worst.deferCount) worst = { project, ...v };
    }
    return worst;
  };
  // #590: once a project's delivery is stuck (deferCount ≥ maxDefers), skip
  // whole-project attempts on an exponentially growing cadence (capped 60s)
  // instead of retrying every 1s tick forever — cuts churn without ever
  // dropping the message (the cursor never advances past a deferred entry, so
  // it still delivers the moment the blocker clears).
  const projectBackoff = new Map<string, { nextAttemptAt: number; streak: number }>();
  // #579/#484: deferring forever behind an actively-changing draft is the
  // correct, SAFE behaviour — but safe-and-silent is #560's disease. Track
  // which projects we've already alerted on for the CURRENT stall episode so
  // the alert fires exactly once per episode (edge-triggered, mirrors the
  // #354 quietNotifiedAt / #492 anti-flood pattern), not once per poll. Clears
  // when stats().stuck drops back to false, re-arming for a later episode.
  const stuckNotified = new Set<string>();
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
      reap: async (project) => {
        const reaped = await reapOrphanedCrews(store, project, surfaceProbe);
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
      cfg.commandName,
    ])];

    for (const project of allProjects) {
      // #590: a stuck/throwing project must never delay or take down delivery
      // for every OTHER project in this same tick — each project's pass is
      // isolated, so one jam only ever costs that one project's slot.
      try {
        // #590: still backing off this stuck project — skip the whole pass
        // (including the cmux round trips below) until nextAttemptAt.
        const backoff = projectBackoff.get(project);
        if (backoff && Date.now() < backoff.nextAttemptAt) continue;

        const projCfg = cfg.projects?.[project];
        const captainTitle = project === cfg.commandName
          ? cfg.commandName
          : (projCfg?.captainName ?? `${project}-captain`);

        // Surface discovery is ONLY for the delivery target (where to cmux.send);
        // captain presence/liveness authority now lives in livenessRegistry.
        let surface: PaneRef | null = null;
        const resolveCaptainSurface = async (): Promise<PaneRef | null> => {
          const wsId = cmux.findWorkspaceId ? await cmux.findWorkspaceId(captainTitle) : null;
          if (!wsId) return injectedSurfaces[project] ?? null;
          const surfaces = await cmux.listSurfaces(wsId);
          // Fall back to injected surface (tests / config-less projects).
          return discoverCaptainSurface(surfaces, captainTitle) ?? injectedSurfaces[project] ?? null;
        };
        surface = await resolveCaptainSurface();

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
              // #531: exempt non-daemon captain.message (human/cli) from stale-skip
              const isExemptMessage = entry.kind === "captain.message" && entry.payload?.source !== "daemon";
              if (!isExemptMessage) {
                log(`delivery seq=${entry.seq} kind=${entry.kind} outcome=stale-skipped`);
                await writeCursor({ stateRoot, project, subscriber: CURSOR_SUBSCRIBER, lastAckedSeq: entry.seq });
                continue;
              }
              log(`delivery seq=${entry.seq} kind=${entry.kind} outcome=stale-exempt-deliver`);
            } else {
              log(`delivery seq=${entry.seq} kind=${entry.kind} outcome=stale-terminal-deliver`);
            }
          }
          const result = await d.deliver(entry, async (text, sendOpts) => {
            // #667 slice 4: try the native channel first. A throw here must never
            // break delivery — fall through to the pane, which is the behaviour that
            // predates this slice.
            let handledByChannel = false;
            try {
              const mode = ctx.captainChannelMode?.() ?? "off";
              const r = await deliverToCaptain(project, text, {
                channel: ctx.captainChannel,
                mode,
                log,
              });
              handledByChannel = r.handled;
            } catch (e) {
              log(`captain-channel ${project}: threw, falling back to pane — ${(e as Error).message}`);
            }
            if (handledByChannel) {
              // Reached the captain (or a human gate in front of it). Advance the
              // cursor and do NOT also write the pane.
              return;
            }
            try {
              return await cmux.send(surface!, text, sendOpts);
            } catch (e) {
              // #713: probe-failed (#714) means the cmux invocation itself failed
              // — most likely a stale surface ref after a captain restart. The
              // resolved surface is never re-resolved otherwise, so a dead ref
              // would defer forever (the ~4h 2026-08-22 jam). Re-resolve once via
              // the same discovery path and retry against the new surface. Only
              // probe-failed triggers this: no-box/modal/draft mean the surface
              // is alive and the pane is merely busy — re-resolving those would
              // churn. Guarded against looping: no new surface (none found, or
              // the SAME one that just failed) defers normally.
              if (!(e instanceof DeferDelivery) || e.reason !== "probe-failed") throw e;
              const next = await resolveCaptainSurface();
              const same = next !== null
                && next.workspaceId === surface!.workspaceId
                && next.surfaceId === surface!.surfaceId;
              if (!next || same) {
                log(`delivery project=${project}: probe-failed but surface re-resolution found ${next ? "the same dead surface" : "no captain surface"} — deferring`);
                throw e;
              }
              log(`delivery project=${project}: probe-failed on ${surface!.workspaceId}/${surface!.surfaceId} — re-resolved to ${next.workspaceId}/${next.surfaceId}, retrying`);
              surface = next;
              return cmux.send(next, text, sendOpts);
            }
          });
          if ("delivered" in result) {
            log(`delivery seq=${entry.seq} kind=${entry.kind} outcome=delivered`);
            await writeCursor({ stateRoot, project, subscriber: CURSOR_SUBSCRIBER, lastAckedSeq: entry.seq });
            lastDeferred.delete(project);
            projectBackoff.delete(project);
          } else {
            // #617: project+reason make a defer episode attributable after the
            // fact (previously: no project, no cause — see issue). Logging every
            // 1s tick for up to maxDefers (~300, ~30min) would flood the log for
            // no forensic gain once the cause is known, so we log the onset
            // (first defer of this seq) and then every 30th tick (~30s cadence)
            // — enough resolution to correlate a later stuck/SIGTERM event
            // without adding meaningful volume.
            const { maxDeferCount, stuck } = d.stats();
            if (maxDeferCount === 1 || maxDeferCount % 30 === 0) {
              log(`delivery seq=${entry.seq} kind=${entry.kind} outcome=deferred project=${project} reason=${result.reason}`);
            }
            lastDeferred.set(project, { seq: entry.seq, deferCount: maxDeferCount });
            // #590: once stuck, grow the retry interval (1s → 2s → 4s … capped
            // 60s) instead of retrying every tick forever. The message is never
            // dropped — the cursor still hasn't advanced past it, so the very
            // next attempt (once nextAttemptAt passes) picks up right where this
            // left off and delivers the instant the blocker clears.
            if (stuck) {
              const streak = (projectBackoff.get(project)?.streak ?? 0) + 1;
              const backoffMs = Math.min(60_000, 1000 * 2 ** streak);
              projectBackoff.set(project, { nextAttemptAt: Date.now() + backoffMs, streak });
            }
            break;
          }
        }

        // #579/#484: fail LOUD, not silent, once this project's delivery is
        // stuck (deferCount crossed maxDefers — an actively-changing draft that
        // never stabilizes, so the structural probe never gets to run).
        //
        // The mailbox entry alone is NOT enough: it's drained by this same
        // stuck delivery pipeline, so it queues behind the very block it's
        // reporting and only surfaces once the stall has already resolved
        // (fail-silent-then-apologize). Kept here as a post-resolution audit
        // trail, discoverable even if the operator never opens the dashboard.
        //
        // Two independent out-of-band channels fire alongside it, neither of
        // which touches the stuck pane/mailbox:
        //  - notifyFault: the notifier plugin slot (cmux by default — see
        //    @squadrant/workspaces' NotifierRegistry). ALWAYS resolved in
        //    production (never undefined), so it's the channel that works with
        //    ZERO Telegram configuration — closing the gap where Telegram alone
        //    left every non-Telegram install silent.
        //  - telegramBridge.pushRaw: reaches a phone even when the operator
        //    isn't watching a terminal. Optional — only when Telegram is set up.
        // The daemon's own health snapshot (`deferral.stuck`) is also surfaced
        // as `detail` on the captain's ComponentHealth row (see liveness.ts),
        // so `squadrant doctor` / `squadrant status --detailed` show it too —
        // a third, pull-based, zero-configuration surface.
        const stuck = d.stats().stuck;
        if (stuck && !stuckNotified.has(project)) {
          stuckNotified.add(project);
          const { maxDeferCount, reason } = d.stats();
          log(`delivery stuck project=${project} deferCount=${maxDeferCount} reason=${reason ?? "unknown"}`);
          // #617/#714: report the ACTUAL blocker instead of always blaming the
          // input box — a modal (#484) isn't a draft, and a failed screen probe
          // (#714) is neither: it's a dead surface/cmux invocation failure that
          // re-resolution should heal (#713). One distinct sentence per reason.
          const text = STUCK_ALERT_TEXT[reason ?? "unknown"](maxDeferCount);
          // #590: awaited (not fire-and-forget) — once a project can be backed
          // off to a whole tick's worth of no-op skips, this write needs to be
          // durably landed before the tick "completes" rather than racing
          // whatever the caller does next.
          try {
            await appendCaptainMessage({ stateRoot, project, text, source: "daemon" });
          } catch (e) {
            log(`delivery stuck alert failed project=${project}: ${(e as Error).message}`);
          }
          Promise.resolve(notifyFault(project, text))
            .catch((e) => log(`delivery stuck fault-notify failed project=${project}: ${(e as Error).message}`));
          telegramBridge?.pushRaw(project, text);
        } else if (!stuck && stuckNotified.has(project)) {
          stuckNotified.delete(project);
        }
      } catch (e) {
        // #590: isolate one project's failure — log and move on to the next
        // project this same tick, rather than aborting the whole pass (the
        // pre-fix behaviour: an exception here used to skip every project
        // that iterates after this one, every tick, for as long as the fault
        // persisted).
        log(`delivery project=${project}: unhandled error — ${(e as Error).message}`);
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

  return { defaultNotify, deliveryTick, deliveryStats, inFlightDelivery };
}
