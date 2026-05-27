// src/control/daemon.ts
import type { Store } from "./store.js";
import type { ControlEvent, TaskRecord, TaskState } from "./types.js";
import { reduce } from "./state-machine.js";
import { evaluateStall, recoverStall } from "./watchdog.js";

export interface DaemonDeps {
  store: Store;
  now: () => number;
  /** Injected in Task 14; resumes a blocked session. Optional until then. */
  deliverReply?: (rec: TaskRecord, message: string) => Promise<void>;
  /** Defaults to a real process.kill(pid,0) check at the call site (Task 17). */
  isPidAlive?: (pid: number) => boolean;
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
}

const ATTENTION_STATES: ReadonlySet<TaskState> = new Set(["done", "blocked", "failed", "stalled"]);

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatMessage(rec: TaskRecord): string | null {
  const tag = `[${rec.provider}/${rec.name != null ? rec.name : shortId(rec.id)}]`;
  switch (rec.state) {
    case "done": {
      // Spec: "<resultRef-content-first-line-or-the-task-snippet>".
      // resultRef content lives on disk; for daemon-purity we don't read it
      // here. The task snippet is the documented fallback and gives the
      // captain enough context to know which crew finished.
      const snippet = (rec.task ?? "").split(/\r?\n/)[0]?.trim().slice(0, 120) ?? "";
      return `CREW DONE ${tag}: ${snippet}`;
    }
    case "blocked":
      return `CREW BLOCKED ${tag}: ${(rec.question ?? "(no question)").trim()}`;
    case "failed":
      return `CREW FAILED ${tag}: ${(rec.error ?? "(no error)").trim()}`;
    case "stalled":
      return `CREW STALLED ${tag}: no heartbeat in ${rec.heartbeatBudgetMs}ms`;
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
): void {
  if (!deps.notify) return;
  if (prev === next.state) return;
  if (!ATTENTION_STATES.has(next.state)) return;
  const message = formatMessage(next);
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
  return {
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
          const next = reduce(cur, req.event, now());
          if (next !== cur) {
            store.put(next); // skip redundant write on terminal no-ops
            firePush(deps, req.project, cur.state, next, req.event);
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
    sweep(): void {
      const t = now();
      for (const r of store.listAll()) {
        const stalled = evaluateStall(r, t);
        if (stalled) {
          store.put(stalled);
          const synthEvent: ControlEvent = {
            type: "task.stalled",
            id: r.id,
            heartbeatBudgetMs: r.heartbeatBudgetMs,
          };
          firePush(deps, r.project, r.state, stalled, synthEvent);
          continue;
        }
        const recovered = recoverStall(r, t);
        // recoverStall does NOT check heartbeat freshness — guard per its contract
        if (recovered && t - r.lastHeartbeat <= r.heartbeatBudgetMs) store.put(recovered);
      }
    },
    reconcile(): void {
      const alive = deps.isPidAlive ?? (() => true);
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
          firePush(deps, r.project, r.state, failed, synthEvent);
        } else {
          const stalled: TaskRecord = { ...r, state: "stalled", lastEvent: "reconcile" };
          store.put(stalled);
          const synthEvent: ControlEvent = {
            type: "task.reconcile-failed",
            id: r.id,
            reason: "interactive task lost on daemon restart",
          };
          firePush(deps, r.project, r.state, stalled, synthEvent);
        }
      }
    },
  };
}
