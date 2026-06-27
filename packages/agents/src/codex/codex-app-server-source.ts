// codex-app-server-source.ts — LifecycleSource adapter for the codex app-server.
//
// Implements D5 from the #333 design: wraps the existing CodexInteractiveDriver
// as a LifecycleSource without changing the driver's internals.
//
// Mechanism: the daemon emit path calls observe(ev) with every ControlEvent that
// CodexInteractiveDriver emits. This source maps those events to LifecycleSnapshots
// and feeds them into the reduceLifecycle pipeline via deps.report().
//
// Correlation: codex ControlEvents already carry ev.id (taskId), so no
// deps.resolve() lookup is needed — taskId is known at the call site.
//
// NOT wired into the live daemon in Phase 1 (additive per D3/D7).
// The sibling NativeHookSource crew wires both sources in after this file lands.

import type { LifecycleSource, LifecycleSourceDeps, LifecycleSnapshot } from "@squadrant/core";
import type { ControlEvent } from "@squadrant/shared";

// ── CodexAppServerSource ─────────────────────────────────────────────────────

/**
 * LifecycleSource adapter for the codex app-server driver.
 *
 * Push-only source: the app-server is event-driven, not polled. snapshot()
 * returns the last reported state for the liveness floor.
 *
 * Usage (daemon wiring, handled by sibling crew):
 *   const source = new CodexAppServerSource();
 *   source.start(deps);
 *   // Wrap the driver's emit so every event also passes through the source:
 *   const emit = (ev) => { source.observe(ev); handle(ev); };
 *   const driver = new CodexInteractiveDriver({ emit, ... });
 */
export class CodexAppServerSource implements LifecycleSource {
  readonly name = "codex-appserver";

  private deps?: LifecycleSourceDeps;
  /** taskId → last reported snapshot (for snapshot() liveness floor). */
  private cache = new Map<string, LifecycleSnapshot>();

  start(deps: LifecycleSourceDeps): void {
    this.deps = deps;
  }

  stop(): void {
    this.deps = undefined;
    this.cache.clear();
  }

  /** Returns the last-reported snapshot for a known crew (liveness floor). */
  snapshot(taskId: string): LifecycleSnapshot | undefined {
    return this.cache.get(taskId);
  }

  /**
   * Feed a ControlEvent from CodexInteractiveDriver into this source.
   * The daemon wires: emit = (ev) => { source.observe(ev); handle(ev); }
   *
   * All events that carry lifecycle meaning for a codex crew are mapped to a
   * LifecycleSnapshot and reported. Events that are terminal signals (task.done,
   * task.cancelled, task.blocked) or notify-only (task.stalled, task.quiet, etc.)
   * are ignored — terminal state still comes exclusively from `squadrant crew signal`
   * (anti-#2576 invariant).
   */
  observe(ev: ControlEvent): void {
    const snap = toSnapshot(ev);
    if (!snap || !this.deps) return;
    this.cache.set(snap.taskId, snap);
    this.deps.report(snap);
  }
}

// ── private: ControlEvent → LifecycleSnapshot ────────────────────────────────

function toSnapshot(ev: ControlEvent): LifecycleSnapshot | null {
  const now = Date.now();
  switch (ev.type) {
    // ── running: a turn is live ──────────────────────────────────────────────
    case "task.started":
    case "task.reattached":
    case "task.turn.started":
    case "task.delta":
    case "task.progress":
      return { taskId: ev.id, state: "running", alive: true, origin: "agent", at: now };

    // ── idle: turn ended, crew alive, awaiting next input ────────────────────
    // task.failed: the turn ended with an error, but the crew process is alive.
    // task.session.ended: process is gone (alive:false) — signals liveness loss.
    case "task.turn.completed":
      return { taskId: ev.id, state: "idle", alive: true, origin: "agent", at: now };

    case "task.failed":
      return { taskId: ev.id, state: "idle", alive: true, origin: "agent", at: now };

    case "task.session.ended":
      return { taskId: ev.id, state: "idle", alive: false, origin: "agent", at: now };

    // ── needsInput: crew is blocked on a human ───────────────────────────────
    case "task.approval.requested":
      return {
        taskId: ev.id, state: "needsInput", alive: true, origin: "agent", at: now,
        detail: { note: ev.question, reason: ev.kind },
      };

    case "task.input.requested":
      return {
        taskId: ev.id, state: "needsInput", alive: true, origin: "agent", at: now,
        detail: { note: ev.question },
      };

    // ── terminal / notify-only — ignored ────────────────────────────────────
    // task.done, task.blocked, task.cancelled: terminal state from crew signal only.
    // task.session, task.stalled, task.quiet, task.idle, task.timeout, etc.: no-op.
    default:
      return null;
  }
}
