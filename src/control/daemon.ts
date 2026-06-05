// src/control/daemon.ts
import type { Store } from "./store.js";
import type { ControlEvent, TaskRecord, TaskState } from "./types.js";
import { reduce } from "./state-machine.js";
import { evaluateStall, recoverStall } from "./watchdog.js";
import { classifyHealth, RELAY_STALE_MS, RELAY_GONE_MS, type RelayHealth } from "./liveness.js";

export interface DaemonDeps {
  store: Store;
  now: () => number;
  /** Injected in Task 14; resumes a blocked session. Optional until then. */
  deliverReply?: (rec: TaskRecord, message: string) => Promise<void>;
  /** Defaults to a real process.kill(pid,0) check at the call site (Task 17). */
  isPidAlive?: (pid: number) => boolean;
  /**
   * #139 backstop: the interactive analogue of isPidAlive. Resolves whether an
   * interactive crew's backing cmux surface (pane/tab) still exists. Three-valued
   * so a transient cmux outage never false-reaps a live crew:
   *   - "alive"   → the crew's pane is present; keep watching.
   *   - "gone"    → cmux answered AND the pane is provably absent → terminalize.
   *   - "unknown" → could not determine (cmux down, no captain, error) → do nothing.
   * Defaults to always-"unknown" (never reaps) when not wired — pure unit tests
   * and any non-cmux deployment are unaffected.
   */
  isSurfaceAlive?: (rec: TaskRecord) => Promise<"alive" | "gone" | "unknown">;
  /** Wired in cockpitd to runHeadless; absent in pure unit tests. */
  launchHeadless?: (rec: TaskRecord) => Promise<void>;
  /**
   * Forward hook for the deferred interactive-wiring spec. While absent,
   * interactive dispatch fails LOUD (red-team #4) instead of silently
   * black-holing in `submitted` forever.
   */
  launchInteractive?: (rec: TaskRecord) => Promise<void>;
  /**
   * Wired in cockpitd to codexDriver.answer(). Delivers the captain's gate
   * resolution payload back to the interactive session (spec §4.9).
   */
  resolveInteractiveGate?: (taskId: string, payload: unknown) => Promise<void> | void;
  /**
   * Push notification hook (#109, refactored under mailbox-injector spec).
   * Called on every state transition into {done, blocked, failed, stalled}.
   * Implementations append to the mailbox; errors are caught + swallowed here
   * so an unhealthy notifier never breaks the event-ingest path.
   */
  notify?: (args: {
    project: string;
    message: string;
    record: TaskRecord;
    event: ControlEvent;
  }) => Promise<void> | void;
  /**
   * #207 relay heal (SECONDARY — best-effort). Called once per "down" episode
   * when the sweep finds a registered relay gone dark. The default impl
   * (cockpitd) attempts a `spawnInjector` re-spawn, but is mostly inert in prod:
   * the launchd daemon is outside cmux's process-lineage and cannot inject. The
   * non-negotiable guarantee — "captain never SILENTLY blind" — is delivered by
   * getRelayHealth() + the liveness surface, not by this hook. Errors are
   * swallowed by the sweep so a refused cmux write never trips the daemon.
   */
  healRelay?: (project: string) => Promise<void> | void;
}

// 'awaiting-input' is an attention state: entering it (idle watchdog OR a
// Stop-hook turn boundary) fires exactly one accurate CREW IDLE push. The
// firePush prev===next guard keeps it from re-firing while the task sits idle.
const ATTENTION_STATES: ReadonlySet<TaskState> = new Set(["done", "blocked", "failed", "stalled", "awaiting-input"]);

// #139: non-terminal, post-launch states an interactive crew can be sitting in
// while its session has actually died. Any of these with a provably-gone surface
// is a zombie → reap to 'cancelled'. 'submitted' is excluded: it is pre-launch
// (no surface yet), so reaping it would race the spawn.
const REAPABLE_SURFACE_STATES: ReadonlySet<TaskState> = new Set(["working", "stalled", "awaiting-input", "blocked"]);

// #210: CREW IDLE (awaiting-input) is debounced — suppressed when the turn-end
// lands within this window of the captain's own last turn to the crew (a
// `crew send`/reply emits task.started). This silences the rapid
// send→respond→turn-end churn of an active back-and-forth while still
// delivering a genuine self-idle (turn-end / idle-watchdog long after the
// captain last engaged). Only awaiting-input is debounced; every other
// attention state always delivers.
export const IDLE_DEBOUNCE_MS = 12_000;

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatMessage(rec: TaskRecord, event?: ControlEvent): string | null {
  const tag = `[${rec.provider}/${rec.name != null ? rec.name : shortId(rec.id)}]`;
  switch (rec.state) {
    case "done": {
      // Prefer the crew's own done message (`signal done --message`), carried on
      // the task.done event — this is what captains relied on under the old
      // relay formatter and must not regress (#214 unification). The task
      // snippet is the documented fallback when no message was provided.
      const doneMsg = event?.type === "task.done" ? event.message : undefined;
      const body =
        doneMsg != null && doneMsg.trim().length > 0
          ? doneMsg.split(/\r?\n/)[0].trim().slice(0, 200)
          : ((rec.task ?? "").split(/\r?\n/)[0]?.trim().slice(0, 120) ?? "");
      return `CREW DONE ${tag}: ${body}`;
    }
    case "blocked":
      return `CREW BLOCKED ${tag}: ${(rec.question ?? "(no question)").trim()}`;
    case "failed":
      return `CREW FAILED ${tag}: ${(rec.error ?? "(no error)").trim()}`;
    case "stalled":
      return `CREW STALLED ${tag}: no heartbeat in ${rec.heartbeatBudgetMs}ms`;
    case "awaiting-input":
      return `CREW IDLE ${tag}: turn ended / awaiting your input — review and reply or close.`;
    default:
      return null;
  }
}

function firePush(
  deps: DaemonDeps,
  project: string,
  prev: TaskState,
  next: TaskRecord,
  event: ControlEvent,
  lastCaptainTurnAt?: number,
): void {
  if (!deps.notify) return;
  if (prev === next.state) return;
  if (!ATTENTION_STATES.has(next.state)) return;
  // #210 idle debounce: a turn-end (awaiting-input) within IDLE_DEBOUNCE_MS of
  // the captain's last turn is part of an active back-and-forth — suppress the
  // CREW IDLE. All other attention states are never debounced.
  if (
    next.state === "awaiting-input" &&
    lastCaptainTurnAt != null &&
    deps.now() - lastCaptainTurnAt <= IDLE_DEBOUNCE_MS
  ) {
    return;
  }
  const message = formatMessage(next, event);
  if (!message) return;
  // Fire-and-forget; swallow errors so the daemon never trips on a flaky
  // notifier. Sync throws and async rejections both land here.
  try {
    const r = deps.notify({ project, message, record: next, event });
    if (r && typeof (r as Promise<void>).catch === "function") {
      (r as Promise<void>).catch(() => {});
    }
  } catch {
    // intentionally swallowed
  }
}

type Req =
  | { kind: "dispatch"; record: TaskRecord }
  | { kind: "event"; project: string; event: ControlEvent }
  | { kind: "status"; project: string; id: string }
  | { kind: "list"; project: string }
  | { kind: "reply"; project: string; id: string; message: string }
  | { kind: "gate-resolve"; project: string; gateId: string; resolvedBy: string; payload: unknown };

export function createDaemon(deps: DaemonDeps) {
  const { store, now } = deps;
  // #210: per-task timestamp of the captain's most recent turn (a `crew send`/
  // reply/answer emits task.started). Used to debounce CREW IDLE during an
  // active back-and-forth. Bounded by the live task set; never read after a
  // task terminates (terminal states don't transition to awaiting-input).
  const lastCaptainTurnAt = new Map<string, number>();
  // #207: per-project relay registration + last heartbeat. The relay registers
  // over the socket on boot and beats every ~10s; the sweep health-checks these.
  const relayHealth = new Map<string, RelayHealth>();
  // Per-project last heal attempt, so a persistently-dark relay is healed once
  // per episode, not every 30s sweep. Re-armed (deleted) when a fresh heartbeat
  // proves the relay recovered.
  const lastHealAttempt = new Map<string, number>();
  return {
    /** #207: a notify-relay announced itself (boot). */
    registerRelay(r: { project: string; pid: number; startedAt: number }): void {
      relayHealth.set(r.project, { ...r, lastSeenMs: now() });
      lastHealAttempt.delete(r.project);
    },
    /** #207: a notify-relay heartbeat (every ~10s). Re-arms heal. */
    relayHeartbeat(r: { project: string; pid: number }): void {
      const prev = relayHealth.get(r.project);
      relayHealth.set(r.project, {
        project: r.project,
        pid: r.pid,
        startedAt: prev?.startedAt ?? now(),
        lastSeenMs: now(),
      });
      lastHealAttempt.delete(r.project);
    },
    /** #207/#77: snapshot of every registered relay's health (for the surface). */
    getRelayHealth(): RelayHealth[] {
      return [...relayHealth.values()];
    },
    async handle(req: Req): Promise<TaskRecord | TaskRecord[]> {
      switch (req.kind) {
        case "dispatch": {
          store.put(req.record);
          if (req.record.mode === "headless" && deps.launchHeadless) {
            deps.launchHeadless(req.record).catch((e: unknown) => {
              const error = e instanceof Error ? e.message : String(e);
              store.put({ ...req.record, state: "failed", lastEvent: "launch-error", error });
            });
            return req.record;
          }
          if (req.record.mode === "interactive" && deps.launchInteractive) {
            deps.launchInteractive(req.record).catch((e: unknown) => {
              const error = e instanceof Error ? e.message : String(e);
              store.put({ ...req.record, state: "failed", lastEvent: "launch-error", error });
            });
            return req.record;
          }
          // No launcher for this mode → fail LOUD, never silently park in
          // `submitted` (red-team #4). Interactive launcher is the deferred
          // interactive-wiring spec; until then, say so explicitly.
          const failed: TaskRecord = {
            ...req.record,
            state: "failed",
            lastEvent: "no-launcher",
            error:
              req.record.mode === "interactive"
                ? "interactive mode is not yet implemented (deferred interactive-wiring spec); use --mode headless"
                : `no launcher available for mode '${req.record.mode}'`,
          };
          store.put(failed);
          return failed;
        }
        case "event": {
          const cur = store.get(req.project, req.event.id);
          if (!cur) throw new Error(`unknown task ${req.event.id}`);
          // A captain turn (crew send/reply) arrives as task.started → record it
          // so a quick trailing turn-end is debounced (#210).
          if (req.event.type === "task.started") lastCaptainTurnAt.set(req.event.id, now());
          const next = reduce(cur, req.event, now());
          if (next !== cur) {
            store.put(next); // skip redundant write on terminal no-ops
            firePush(deps, req.project, cur.state, next, req.event, lastCaptainTurnAt.get(next.id));
          }
          return next;
        }
        case "status": {
          const r = store.get(req.project, req.id);
          if (!r) throw new Error(`unknown task ${req.id}`);
          return r;
        }
        case "list":
          return store.list(req.project);
        case "reply": {
          const r = store.get(req.project, req.id);
          if (!r) throw new Error(`unknown task ${req.id}`);
          if (r.state !== "blocked") throw new Error(`task ${req.id} is not blocked (state=${r.state})`);
          // The captain's answer is a turn to the crew (#210 debounce key).
          lastCaptainTurnAt.set(r.id, now());
          const next = reduce(r, { type: "task.started", id: r.id }, now());
          store.put(next); // persist the transition before delivering (durable first)
          if (deps.deliverReply) await deps.deliverReply(r, req.message);
          return next;
        }
        case "gate-resolve": {
          // Find the task that owns this gate.
          const owning = deps.store.listAll().find((r) => r.gates?.some((g) => g.gateId === req.gateId));
          if (!owning || !owning.gates) throw new Error(`gate ${req.gateId} not found`);
          const updatedGates = owning.gates.map((g) =>
            g.gateId === req.gateId
              ? { ...g, state: "resolved" as const, resolvedBy: req.resolvedBy, resolution: req.payload }
              : g,
          );
          deps.store.put({ ...owning, gates: updatedGates });
          // Driver answers via the saved requestId (it tracks it per-task internally).
          if (deps.resolveInteractiveGate) await deps.resolveInteractiveGate(owning.id, req.payload);
          return { ...owning, gates: updatedGates };
        }
        default: { const _exhaustive: never = req; throw new Error(`unhandled request kind`); }
      }
    },
    async sweep(): Promise<void> {
      const t = now();
      const surfaceAlive = deps.isSurfaceAlive ?? (async () => "unknown" as const);
      for (const r of store.listAll()) {
        // #139 backstop: reap interactive records whose backing surface is
        // PROVABLY gone (crew session died with no terminal signal — opencode has
        // no SessionEnd hook, and a hard kill can drop claude's). This is
        // liveness-based reaping, NOT a shorter timeout: the 24h heartbeat budget
        // is untouched, so a legitimately-idle LIVE crew is never reaped (its
        // surface answers "alive" and falls through to evaluateStall → CREW IDLE).
        // "unknown" (cmux down) never reaps. cancelled is silent (not in
        // ATTENTION_STATES) — no false CREW STALLED re-emitted.
        if (r.mode === "interactive" && REAPABLE_SURFACE_STATES.has(r.state)) {
          const liveness = await surfaceAlive(r);
          if (liveness === "gone") {
            store.put({ ...r, state: "cancelled", lastEvent: "sweep.surface-gone" });
            continue;
          }
        }
        const idle = evaluateStall(r, t);
        if (idle) {
          store.put(idle);
          // Interactive idle → awaiting-input (task.idle); headless → stalled
          // (task.stalled). The synth event only carries the notify payload;
          // the reducer treats both as no-ops (state already updated above).
          const synthEvent: ControlEvent =
            idle.state === "awaiting-input"
              ? { type: "task.idle", id: r.id, heartbeatBudgetMs: r.heartbeatBudgetMs }
              : { type: "task.stalled", id: r.id, heartbeatBudgetMs: r.heartbeatBudgetMs };
          firePush(deps, r.project, r.state, idle, synthEvent, lastCaptainTurnAt.get(r.id));
          continue;
        }
        const recovered = recoverStall(r, t);
        // recoverStall does NOT check heartbeat freshness — guard per its contract
        if (recovered && t - r.lastHeartbeat <= r.heartbeatBudgetMs) store.put(recovered);
      }
      // #207 relay health-check: a registered relay gone dark past the gone
      // window is down. Best-effort heal, debounced to once per episode. The
      // surface (getRelayHealth) already exposes the "gone" state regardless —
      // that is the never-silently-blind guarantee; heal is the secondary try.
      if (deps.healRelay) {
        for (const rh of relayHealth.values()) {
          if (classifyHealth(rh.lastSeenMs, t, RELAY_STALE_MS, RELAY_GONE_MS) !== "gone") continue;
          const last = lastHealAttempt.get(rh.project);
          if (last != null && t - last <= RELAY_GONE_MS) continue; // debounce
          lastHealAttempt.set(rh.project, t);
          try {
            const r = deps.healRelay(rh.project);
            if (r && typeof (r as Promise<void>).catch === "function") {
              (r as Promise<void>).catch(() => {});
            }
          } catch {
            // best-effort — a refused cmux write (lineage) must not trip the sweep
          }
        }
      }
    },
    async reconcile(): Promise<void> {
      const alive = deps.isPidAlive ?? (() => true);
      const surfaceAlive = deps.isSurfaceAlive ?? (async () => "unknown" as const);
      for (const r of store.listAll()) {
        if (r.state !== "working" && r.state !== "submitted") continue;
        if (r.mode === "headless") {
          if (r.pid != null && alive(r.pid)) continue; // still running, keep watching
          const failed: TaskRecord = {
            ...r, state: "failed", lastEvent: "reconcile",
            error: "orphaned by daemon restart; exit unobserved (conservative fail)",
          };
          store.put(failed);
          const synthEvent: ControlEvent = {
            type: "task.failed",
            id: r.id,
            error: failed.error ?? "reconcile",
          };
          firePush(deps, r.project, r.state, failed, synthEvent, lastCaptainTurnAt.get(r.id));
        } else {
          // #139: an interactive crew's cmux pane SURVIVES a daemon bounce, so a
          // live crew must stay 'working' for the reattach loop to re-subscribe
          // it. The old unconditional → 'stalled' both false-stalled live crews
          // AND fired CREW STALLED on every restart. Reap ONLY when the surface
          // is provably gone; alive/unknown stay working (sweep re-checks later).
          const liveness = await surfaceAlive(r);
          if (liveness === "gone") {
            store.put({ ...r, state: "cancelled", lastEvent: "reconcile.surface-gone" });
            // silent — the crew is gone; no alarming push (consistent with close).
          }
        }
      }
    },
  };
}
