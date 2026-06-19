// src/control/daemon.ts
import type { Store } from "./store.js";
import type { ControlEvent, TaskRecord, TaskState } from "@cockpit/shared";
import { TERMINAL_STATES } from "@cockpit/shared";
import { reduce } from "./state-machine.js";
import { evaluateStall, recoverStall } from "./watchdog.js";
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
   * #259: true when a launchHeadless call for this task ID is currently in
   * flight (process spawned but no pid yet). reconcile() skips these so a
   * crash-restart re-run does NOT mark an actively-launching task as failed
   * and re-dispatch it, multiplying orphaned headless processes.
   * Defaults to () => false when not wired (pure unit tests, non-headless modes).
   */
  isHeadlessInFlight?: (id: string) => boolean;
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
   * #225 hard crew task-timeout: wall-clock ceiling in ms. When a non-terminal
   * task's age (now - createdAt) exceeds this, the sweep fires a CREW TIMEOUT
   * escalation via the notify hook. Defaults to DEFAULT_TASK_TIMEOUT_MS (8h).
   * Distinct from the per-task heartbeat budget (stall detection).
   */
  taskTimeoutMs?: number;
}

// #225 hard crew task-timeout: default wall-clock ceiling (8h). A crew can
// heartbeat continuously yet be stuck on one task — the stall watchdog won't
// catch it. This ceiling does. Configurable via DaemonDeps.taskTimeoutMs.
export const DEFAULT_TASK_TIMEOUT_MS = 8 * 60 * 60 * 1000;

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
    case "stalled": {
      // #354: a hung interactive tool call reads differently from a headless
      // heartbeat stall — name the tool and how long it has been outstanding,
      // and frame it as "possibly hung" (recoverable, auto-clears on the tool's
      // PostToolUse), NOT a death notice.
      if (event?.type === "task.stalled" && event.tool) {
        const mins = event.elapsedMs != null ? Math.max(1, Math.round(event.elapsedMs / 60000)) : null;
        return `CREW STALLED ${tag}: still running ${event.tool}${mins != null ? ` ~${mins}min` : ""} — possibly hung (no result yet).`;
      }
      return `CREW STALLED ${tag}: no heartbeat in ${rec.heartbeatBudgetMs}ms`;
    }
    case "awaiting-input":
      return `CREW IDLE ${tag}: turn ended / awaiting your input — review and reply or close.`;
    default:
      return null;
  }
}

/** #246: cross-project delegation report-back message. Called when a task
 *  with originProject settles to a terminal state. Returns a captain-facing
 *  one-liner delivered verbatim to the origin project's captain. */
function formatDelegationReport(rec: TaskRecord, originProject: string, targetProject: string): string | null {
  const shortTask = (rec.task ?? "").split(/\r?\n/)[0]?.trim().slice(0, 120) ?? "";
  switch (rec.state) {
    case "done":
      return `✅ Cross-project task → ${targetProject}: done — ${shortTask}`;
    case "blocked":
      return `⛔ Cross-project task → ${targetProject}: blocked — ${(rec.question ?? "(no question)").trim()}`;
    case "failed":
      return `⛔ Cross-project task → ${targetProject}: failed — ${(rec.error ?? "(no error)").trim()}`;
    case "stalled":
      return `⚠️ Cross-project task → ${targetProject}: stalled (no heartbeat in ${rec.heartbeatBudgetMs}ms)`;
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
  // #246: cross-project delegation report-back. When a delegated task settles
  // (done/blocked/failed/stalled/cancelled), fan the outcome back to the origin
  // project's mailbox so A's relay wakes A's captain (dispatch-and-yield, never
  // poll). 'awaiting-input' is excluded — the origin doesn't need a noise push
  // every time the target crew ends a turn.
  const reportState = next.state === "done" || next.state === "blocked" || next.state === "failed" || next.state === "stalled" || next.state === "cancelled";
  if (next.originProject && next.originProject !== project && reportState) {
    const originMsg = formatDelegationReport(next, next.originProject, project);
    if (originMsg && deps.notify) {
      try {
        const r = deps.notify({ project: next.originProject, message: originMsg, record: next, event });
        if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
      } catch { /* swallowed */ }
    }
  }
}

type Req =
  | { kind: "dispatch"; record: TaskRecord }
  | { kind: "event"; project: string; event: ControlEvent }
  | { kind: "status"; project: string; id: string }
  | { kind: "list"; project: string }
  | { kind: "reply"; project: string; id: string; message: string }
  | { kind: "gate-resolve"; project: string; gateId: string; resolvedBy: string; payload: unknown };

// #87: exhaustive set of known ControlEvent types for socket-boundary validation.
// Any event.type arriving from the wire that is not in this set is rejected with
// a clean structured error before it can reach reduce() or the store.
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "task.started", "task.progress", "heartbeat",
  "task.blocked", "task.done", "task.failed",
  "task.session", "task.turn.started", "task.turn.completed",
  "task.delta", "task.input.requested", "task.approval.requested",
  "task.reattached", "task.reopened",
  "task.stalled", "task.idle", "task.quiet", "task.timeout", "task.reconcile-failed",
  "task.cancelled", "task.session.ended",
]);

export function createDaemon(deps: DaemonDeps) {
  const { store, now } = deps;
  // #210: per-task timestamp of the captain's most recent turn (a `crew send`/
  // reply/answer emits task.started). Used to debounce CREW IDLE during an
  // active back-and-forth. Bounded by the live task set; never read after a
  // task terminates (terminal states don't transition to awaiting-input).
  const lastCaptainTurnAt = new Map<string, number>();
  // #354: per-task debounce for CREW QUIET. Keyed to the liveness timestamp of
  // the quiet episode so exactly one QUIET fires per episode; when the crew shows
  // activity again, liveness advances and a later quiet episode re-notifies.
  const quietNotifiedAt = new Map<string, number>();
  return {
    async handle(req: Req): Promise<TaskRecord | TaskRecord[]> {
      switch (req.kind) {
        case "dispatch": {
          store.put(req.record);
          // #246: cross-project delegation — notify B's mailbox so B's relay
          // wakes B's captain with the request. Skip auto-launch; B's captain
          // decides how to execute (typically spawns a crew).
          if (req.record.originProject) {
            const origin = req.record.originProject;
            const msg = `📨 Cross-project task from ${origin}: ${req.record.task}`;
            if (deps.notify) {
              try {
                const r = deps.notify({ project: req.record.project, message: msg, record: req.record, event: { type: "task.started", id: req.record.id } });
                if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
              } catch { /* swallowed — flaky notifier must not break dispatch */ }
            }
            return req.record;
          }
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
          // #87: validate event.type at the socket boundary before touching state.
          if (!KNOWN_EVENT_TYPES.has((req.event as any).type)) {
            throw new Error(`unknown event type '${(req.event as any).type}' — not a valid ControlEvent`);
          }
          const cur = store.get(req.project, req.event.id);
          if (!cur) throw new Error(`unknown task ${req.event.id}`);
          // A captain turn (crew send/reply) arrives as task.started → record it
          // so a quick trailing turn-end is debounced (#210).
          if (req.event.type === "task.started") lastCaptainTurnAt.set(req.event.id, now());
          // #227: gate SessionEnd behind surface-liveness — only terminalize
          // when the surface is provably GONE. Prevents a nested/spurious
          // SessionEnd from false-cancelling a live crew while preserving the
          // #139 dead-crew behavior. "unknown" never cancels (transient cmux
          // outage), identical to the sweep reaper's semantics.
          if (req.event.type === "task.session.ended" && !TERMINAL_STATES.has(cur.state)) {
            const liveness = deps.isSurfaceAlive ? await deps.isSurfaceAlive(cur) : "unknown";
            if (liveness !== "gone") return cur; // alive/unknown: no-op, keep current state
          }
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
        // #225 root-fix: terminate non-terminal tasks that exceeded the wall-clock
        // ceiling. Terminalization is the persistent dedup — a daemon restart sees
        // the cancelled record and the TERMINAL_STATES gate above blocks re-fire.
        // The volatile firedTimeout Set is removed; terminal state replaces it.
        if (!TERMINAL_STATES.has(r.state)) {
          const ceiling = deps.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
          if (t - r.createdAt > ceiling) {
            const prevState = r.state; // capture BEFORE terminalization (shown in message)
            const tag = `[${r.provider}/${r.name != null ? r.name : shortId(r.id)}]`;
            const hrs = Math.round(ceiling / 3_600_000);
            const msg = `CREW TIMEOUT ${tag}: wall-clock exceeded ${hrs}h (id: ${r.id}, state: ${prevState})`;
            const synthEvent: ControlEvent = { type: "task.timeout", id: r.id, taskTimeoutMs: ceiling };
            // Terminalize first — persisted to store so any future daemon instance
            // sees a terminal record and skips it (flood-proof across restarts).
            store.put({ ...r, state: "cancelled", lastEvent: "sweep.task-timeout" });
            if (deps.notify) {
              try {
                const p = deps.notify({ project: r.project, message: msg, record: r, event: synthEvent });
                if (p && typeof (p as Promise<void>).catch === "function") {
                  (p as Promise<void>).catch(() => {});
                }
              } catch {
                // swallowed — a flaky notifier must never trip the sweep
              }
            }
          }
        }
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
        // #354: evaluateStall now only stalls a HEADLESS heartbeat timeout or a
        // hung INTERACTIVE tool call (PreToolUse with no PostToolUse past the
        // tool-stall budget). A quiet interactive thinking turn no longer stalls
        // here — it is surfaced as CREW QUIET below, keeping the crew `working`.
        const idle = evaluateStall(r, t);
        if (idle) {
          store.put(idle);
          // The synth event only carries the notify payload; the reducer treats
          // it as a no-op (state already updated above). A hung-tool stall carries
          // the tool name + elapsed so the notifier renders the accurate message.
          const synthEvent: ControlEvent = idle.pendingTool
            ? { type: "task.stalled", id: r.id, heartbeatBudgetMs: r.heartbeatBudgetMs, tool: idle.pendingTool.name, elapsedMs: t - idle.pendingTool.since }
            : { type: "task.stalled", id: r.id, heartbeatBudgetMs: r.heartbeatBudgetMs };
          firePush(deps, r.project, r.state, idle, synthEvent, lastCaptainTurnAt.get(r.id));
          continue;
        }
        // #354 CREW QUIET: a `working` interactive crew quiet past its heartbeat
        // budget with NO tool in flight is alive but deep-thinking (no hook fires
        // during pure model thinking). Surface a distinct, non-alarming nudge —
        // NOT 'awaiting-input' (the turn never ended; real CREW IDLE comes only
        // from the Stop hook). State stays `working`; notify once per episode.
        if (r.mode === "interactive" && r.state === "working" && !r.pendingTool) {
          const liveness = r.attempts.at(-1)?.lastHeartbeatAt ?? r.lastHeartbeat;
          const quiet = t - liveness;
          if (quiet > r.heartbeatBudgetMs) {
            if (deps.notify && quietNotifiedAt.get(r.id) !== liveness) {
              quietNotifiedAt.set(r.id, liveness);
              const tag = `[${r.provider}/${r.name != null ? r.name : shortId(r.id)}]`;
              const mins = Math.max(1, Math.round(quiet / 60000));
              const message = `CREW QUIET ${tag}: working ~${mins}min with no tool activity — likely deep thinking (no reply expected yet).`;
              const synthEvent: ControlEvent = { type: "task.quiet", id: r.id, quietMs: quiet };
              try {
                const p = deps.notify({ project: r.project, message, record: r, event: synthEvent });
                if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => {});
              } catch { /* swallowed — a flaky notifier must never trip the sweep */ }
            }
            continue;
          }
        }
        // Activity resumed (or never went quiet) → drop any QUIET debounce marker
        // so the next genuine quiet episode notifies again, and avoid map growth.
        if (quietNotifiedAt.has(r.id)) quietNotifiedAt.delete(r.id);
        const recovered = recoverStall(r, t);
        // recoverStall does NOT check heartbeat freshness — guard per its contract
        if (recovered && t - r.lastHeartbeat <= r.heartbeatBudgetMs) store.put(recovered);
      }
    },
    async reconcile(): Promise<void> {
      const alive = deps.isPidAlive ?? (() => true);
      const surfaceAlive = deps.isSurfaceAlive ?? (async () => "unknown" as const);
      for (const r of store.listAll()) {
        if (r.state !== "working" && r.state !== "submitted") continue;
        if (r.mode === "headless") {
          if (r.pid != null && alive(r.pid)) continue; // still running, keep watching
          if (deps.isHeadlessInFlight?.(r.id)) continue; // #259: launch in-flight, pid not yet set
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
