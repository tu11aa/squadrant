// packages/agents/src/opencode/control-source.ts
//
// LifecycleSource adapter for opencode's HTTP event bus (#667 slice 1).
//
// OpencodeSseBridge is production-wired but is NOT a LifecycleSource: it emits
// ControlEvents straight into the daemon pipeline, bypassing reduceLifecycle's
// agent-over-scan precedence rules and the per-source health board. This adapter
// puts opencode behind the same port claude and codex use, which the 4-state
// model requires.
//
// Deliberately does not touch sse-bridge.ts: the bridge keeps emitting exactly
// what it emits today, and this source observes the same stream in parallel —
// the shape CodexAppServerSource already uses. That is what keeps slice 1
// behaviour-neutral.
import type { LifecycleSource, LifecycleSourceDeps, LifecycleSnapshot } from "@squadrant/core";
import type { ControlEvent } from "@squadrant/shared";

export class OpencodeControlSource implements LifecycleSource {
  readonly name = "opencode-control";

  private deps?: LifecycleSourceDeps;
  private active = false;
  private cache = new Map<string, LifecycleSnapshot>();

  start(deps: LifecycleSourceDeps): void {
    this.deps = deps;
    this.active = true;
  }

  stop(): void {
    this.deps = undefined;
    this.active = false;
    this.cache.clear();
  }

  /** Push-only source — no fallible startup of its own. */
  health(): { active: boolean; error: string | null } {
    return { active: this.active, error: null };
  }

  /** Liveness floor: origin must be "scan" and must not assert needsInput. */
  snapshot(taskId: string): LifecycleSnapshot | undefined {
    const s = this.cache.get(taskId);
    if (!s) return undefined;
    return { ...s, origin: "scan", state: s.state === "needsInput" ? "running" : s.state };
  }

  /**
   * Feed one ControlEvent from OpencodeSseBridge into the port.
   * Wired in squadrantd.ts as: emit = (ev) => { source.observe(ev); …existing… }
   */
  observe(ev: ControlEvent): void {
    if (!this.deps) return;
    const snap = toSnapshot(ev);
    if (!snap) return;
    this.cache.set(snap.taskId, snap);
    this.deps.report(snap);
  }
}

// ── private: ControlEvent → LifecycleSnapshot ────────────────────────────────

function toSnapshot(ev: ControlEvent): LifecycleSnapshot | null {
  const now = Date.now();
  switch (ev.type) {
    // A permission was answered on the bus and the turn resumed.
    case "task.started":
      return { taskId: ev.id, state: "running", alive: true, origin: "agent", at: now };

    // session.idle — the turn finished. Liveness, NOT completion (anti-#2576).
    case "task.turn.completed":
      return { taskId: ev.id, state: "idle", alive: true, origin: "agent", at: now };

    // permission.asked — opencode STATES it is gated. No guessing from pixels.
    case "task.approval.requested":
      return {
        taskId: ev.id, state: "needsInput", alive: true, origin: "agent", at: now,
        detail: { note: ev.question, reason: ev.kind },
      };

    // Terminal (task.done/blocked/cancelled) and notify-only events are ignored:
    // terminal state comes exclusively from `squadrant crew signal`.
    default:
      return null;
  }
}
