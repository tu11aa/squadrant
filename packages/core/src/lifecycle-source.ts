// packages/core/src/lifecycle-source.ts
//
// LifecycleSource port — phase 0 scaffold (issue #333).
//
// Defines the abstraction for normalizing agent lifecycle events from
// heterogeneous sources (cmux store file, native hooks, SSE, app-server)
// into a single 4-state model. NO concrete implementation lives here; this is
// the interface + types + pure reducer only.
//
// WIRING CONSTRAINT: nothing in this file is imported by the live daemon or
// delivery path. It compiles and tests but remains unwired until Phase 1.

// ── normalized lifecycle vocabulary ─────────────────────────────────────────

/** The four canonical crew lifecycle states (mirrors cmux AgentHibernationLifecycleState). */
export type LifecycleState = "running" | "idle" | "needsInput" | "unknown";

/** One observation about one crew, from one source. */
export interface LifecycleSnapshot {
  taskId: string;
  state: LifecycleState;
  /** Is the OS process actually alive (pid-verified)? */
  alive: boolean;
  /**
   * Provenance — the reconciler's tie-breaker.
   * "agent" = explicit hook / SSE / app-server transition (authoritative).
   * "scan"  = inferred from a process/file sweep (liveness only; may NOT assert needsInput).
   */
  origin: "agent" | "scan";
  /** Monotonic stamp (epoch ms) for last-writer reconciliation across sources. */
  at: number;
  pid?: number;
  /** Optional human detail for surfacing CREW BLOCKED / CREW WORKING context. */
  detail?: { note?: string; tool?: string; reason?: string };
}

/**
 * Correlation hints a source passes when resolving a raw signal back to a crew.
 * The daemon tries them in priority order: taskId > pid > cwd > sessionId.
 */
export interface CorrelationHint {
  /** Strongest — SQUADRANT_CREW_TASK_ID injected into every crew's env at spawn. */
  taskId?: string;
  /** From the cmux store or process scan. */
  pid?: number;
  /** Weakest — collision-prone when a worktree is shared. */
  cwd?: string;
  /** Source-internal (cmux sessionId, codex threadId). */
  sessionId?: string;
}

/** What the daemon hands every source: how to correlate + where to report. */
export interface LifecycleSourceDeps {
  /**
   * Map a raw signal back to its owning crew TaskRecord, or undefined.
   * Keeping it injected makes each source independently testable.
   */
  resolve(hint: CorrelationHint): { id: string } | undefined;
  /** Normalized observation → reducer → ControlEvent pipeline. */
  report(snap: LifecycleSnapshot): void;
  log?(msg: string): void;
}

/**
 * The port. Each adapter implements start/stop.
 * Push sources call deps.report() on transition.
 * Poll sources additionally expose snapshot() for the liveness floor sweep.
 */
export interface LifecycleSource {
  /** Identifies the source in logs and the reconciler ("cmux-store" | "native-hook" | …). */
  readonly name: string;
  start(deps: LifecycleSourceDeps): void;
  stop(): void;
  /**
   * Poll hook — optional.
   * Returns the current liveness snapshot for a known crew, or undefined if
   * this source has no view of it. Drives the liveness floor sweep.
   * A poll result MUST set origin:"scan" and MUST NOT assert state:"needsInput".
   */
  snapshot?(taskId: string): LifecycleSnapshot | undefined;
  /**
   * Read-only source-level health (B4 — dashboard visibility into which sources
   * are up). Optional: a source with no fallible startup can omit it and the
   * daemon assumes {active: true, error: null} once registered.
   */
  health?(): { active: boolean; error: string | null };
}

// ── the one reducer all sources feed ────────────────────────────────────────

/**
 * Pure. Reconcile a new snapshot against the crew's last known state.
 *
 * Rules (from cmux FeedCoordinator.swift):
 *   1. Agent-originated signals are authoritative — always trusted.
 *   2. Scan signals can never assert needsInput (hook-only signal).
 *   3. Agent-set needsInput is sticky — only an agent-originated running relaxes it.
 *   4. A stale scan (at <= prev.at when prev is agent-set) does not regress state.
 */
export function reduceLifecycle(
  prev: LifecycleSnapshot | undefined,
  next: LifecycleSnapshot,
): LifecycleState {
  // Rule 1: agent-originated signals are authoritative.
  if (next.origin === "agent") {
    return next.state;
  }

  // Rule 2: scan signals can never assert needsInput.
  if (next.state === "needsInput") {
    return prev?.state ?? "unknown";
  }

  // Rule 3: agent-set needsInput is sticky against scans.
  if (prev?.state === "needsInput") {
    return "needsInput";
  }

  // Rule 4: a stale scan does not regress a more-recent agent state.
  if (prev?.origin === "agent" && prev.at >= next.at) {
    return prev.state;
  }

  return next.state;
}
