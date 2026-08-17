// packages/core/src/control-channel.ts
//
// ControlChannel port (#667 slice 2) — runtime control of a live agent session
// over its own native API, replacing terminal-pixel inference.
//
// AgentDriver is a LAUNCH-time interface (probe / buildCommand / parseOutput /
// stop) with no place for runtime control, so this is a separate port following
// exactly the shape LifecycleSource established. Implementations live in
// @squadrant/agents; core may not import them (one-way package DAG).

import type { ControlChannelMode } from "@squadrant/shared";

/** Which wire an outcome came from. */
export type ChannelName = "claude-peer" | "opencode-http";

// ControlChannelMode is defined ONCE, in @squadrant/shared alongside the config
// schema that carries it (Task 3), and re-exported here for callers that only
// import the port. The package DAG allows core → shared, never the reverse.
export type { ControlChannelMode };

/**
 * The result of a delivery attempt.
 *
 * NEVER a boolean. confirmedSendToPane collapses this five-branch reality into
 * true/false, and that collapse is where the false negatives come from — on
 * 2026-08-13 `crew send` reported "not delivered" twice for messages that had
 * arrived and were visible with a QUEUED marker.
 *
 * `gone` and `unsupported` are the ONLY two branches that fall back to the pane,
 * and both must be logged. A silent fallback reintroduces the ambiguity this
 * port exists to remove.
 */
export type DeliveryOutcome =
  | { status: "accepted"; via: ChannelName }
  | { status: "queued"; via: ChannelName }
  | { status: "held"; via: ChannelName; reason: string }
  | { status: "gone" }
  | { status: "unsupported" };

/** What a non-mutating reachability probe can conclude. Used by shadow mode. */
export type ProbeResult =
  | { status: "reachable"; via: ChannelName }
  | { status: "gone" }
  | { status: "unsupported" };

/**
 * One channel per agent that has a native control API.
 *
 * Capabilities are TIERED, not reduced to their intersection — designing to the
 * common denominator would discard opencode's most valuable endpoints. T2
 * members are optional; an agent that lacks them simply does not implement them.
 *
 *   T0 send     — send()            claude ✅  opencode ✅
 *   T1 observe  — probe()           claude ✅  opencode ✅
 *   T2 interact — interrupt(), …    claude ❌  opencode ✅
 */
export interface ControlChannel {
  /** Identifies the channel in logs and outcomes. */
  readonly name: ChannelName;
  /** The provider string on a TaskRecord this channel serves ("opencode"|"claude"). */
  readonly agent: string;
  /** T0. Deliver one message into a live session. */
  send(taskId: string, message: string): Promise<DeliveryOutcome>;
  /** T1. Non-mutating liveness check. MUST NOT deliver anything. */
  probe(taskId: string): Promise<ProbeResult>;
  /** T2 (optional). Abort the running turn. */
  interrupt?(taskId: string): Promise<boolean>;
}

/**
 * Only a dead session or a missing channel returns to the pane.
 *
 * accepted / queued / held all mean the message REACHED the agent. Retrying any
 * of them manufactures a duplicate — and for claude, a byte-identical retry
 * inside 30 s is silently dropped, producing exactly the false negative this
 * port removes.
 */
export function fallsBackToPane(o: DeliveryOutcome): boolean {
  return o.status === "gone" || o.status === "unsupported";
}

/** Human-readable one-liner. Every fallback and disagreement is logged with this. */
export function describeOutcome(o: DeliveryOutcome): string {
  switch (o.status) {
    case "accepted": return `accepted via ${o.via}`;
    case "queued":   return `queued via ${o.via} (agent mid-turn)`;
    case "held":     return `held via ${o.via}: ${o.reason}`;
    case "gone":     return "session gone — falling back to pane";
    case "unsupported": return "no control channel for this agent — falling back to pane";
  }
}