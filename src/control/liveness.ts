// src/control/liveness.ts
//
// PURE service-health layer (no I/O, no clock) — the #77 foundation. Mirrors
// watchdog.ts: every function derives a verdict from records + an explicit `now`
// so it is fully unit-testable. All runtime probing (cmux reads for captain
// presence, the relay-heartbeat map) is gathered by the caller (cockpitd) and
// passed in already-resolved; this module never touches cmux.
import type { TaskState, Mode } from "@cockpit/shared";

export type ComponentKind = "relay" | "captain" | "crew" | "command";

// alive  = seen within the stale window (healthy)
// stale  = quiet past stale but not yet gone (degrading)
// gone   = dark past the gone window (treat as down)
// unknown = no signal / not applicable (never alarms)
export type HealthState = "alive" | "stale" | "gone" | "unknown";

export interface ComponentHealth {
  kind: ComponentKind;
  project: string;
  /** crew name / captain name / "relay" / "command". */
  ref: string;
  state: HealthState;
  /** epoch ms of last evidence of life, or null when there is no timestamp
   *  source (captain/command presence is a boolean, not a heartbeat). */
  lastSeenMs: number | null;
  /** human-facing context — for a down relay, the actionable recovery command. */
  detail?: string;
}

/** A notify-relay's registration + last heartbeat, tracked by the daemon. */
export interface RelayHealth {
  project: string;
  pid: number;
  startedAt: number;
  lastSeenMs: number;
}

// Relay heartbeats every ~10s (notify-relay). Stale at ~2.5×, gone at ~6×, so a
// single missed beat never flaps to "down" but a truly dead relay is caught
// within one or two daemon sweeps (30s each).
export const RELAY_STALE_MS = 25_000;
export const RELAY_GONE_MS = 60_000;

// Crews legitimately idle for long (24h interactive budget), so the surface uses
// generous windows — these only flag a genuinely dark crew, and #139 already
// reaps provably-dead ones. Display-only; does not drive any state transition.
export const CREW_STALE_MS = 5 * 60_000;
export const CREW_GONE_MS = 30 * 60_000;

/**
 * Pure. Classify a last-seen timestamp into a health state.
 *   null            → "unknown"
 *   age <= staleMs  → "alive"   (boundary inclusive)
 *   age <= goneMs   → "stale"   (boundary inclusive)
 *   else            → "gone"
 */
export function classifyHealth(
  lastSeenMs: number | null,
  now: number,
  staleMs: number,
  goneMs: number,
): HealthState {
  if (lastSeenMs == null) return "unknown";
  const age = now - lastSeenMs;
  if (age <= staleMs) return "alive";
  if (age <= goneMs) return "stale";
  return "gone";
}

/**
 * The actionable recovery instruction surfaced when a relay is down. The daemon
 * cannot re-establish a cmux relay tab itself (launchd is outside cmux's
 * process-lineage), so the honest remedy is a captain-run command. Keeping this
 * in the surface is the "never silently blind" guarantee.
 */
export function relayActionable(project: string): string {
  return `relay DOWN — run: cockpit launch ${project} (re-establishes the notify-relay tab)`;
}

const TERMINAL: ReadonlySet<TaskState> = new Set(["done", "failed", "cancelled"]);

/** Minimal crew shape the projection needs (subset of TaskRecord). */
export interface CrewLiveness {
  id: string;
  name?: string;
  state: TaskState;
  lastHeartbeat: number;
  mode: Mode;
}

/**
 * Pure. Project one project's component health from already-gathered inputs.
 * Emits: a relay row, a captain row, a command row (only when applicable), and
 * one row per non-terminal crew.
 *
 * Captain liveness (#239 Phase A): derived from relay heartbeat presence, not a
 * cmux probe. The relay runs inside the captain's process tree (#240) and beats
 * the daemon every ~10s — relay presence IS captain presence.
 *   relay alive/stale → captain ALIVE
 *   relay gone        → captain GONE
 *   no relay          → captain UNKNOWN (no signal; do not alarm)
 */
export function projectHealth(input: {
  project: string;
  now: number;
  captainName: string;
  relay: RelayHealth | null;
  /** true/false when a command workspace is expected; null = not applicable. */
  commandPresent: boolean | null;
  crews: CrewLiveness[];
}): ComponentHealth[] {
  const { project, now, captainName, relay, commandPresent, crews } = input;
  const out: ComponentHealth[] = [];

  // ── relay ──────────────────────────────────────────────────────────────
  if (relay) {
    const state = classifyHealth(relay.lastSeenMs, now, RELAY_STALE_MS, RELAY_GONE_MS);
    out.push({
      kind: "relay",
      project,
      ref: "relay",
      state,
      lastSeenMs: relay.lastSeenMs,
      detail: state === "alive" ? `pid ${relay.pid}` : relayActionable(project),
    });
  } else {
    // No relay registered. Without the cmux probe (denied from launchd, #239)
    // we cannot distinguish "captain alive but relay dead" from "nothing
    // running" — report unknown rather than falsely alarm.
    out.push({
      kind: "relay",
      project,
      ref: "relay",
      state: "unknown",
      lastSeenMs: null,
    });
  }

  // ── captain ────────────────────────────────────────────────────────────
  // Relay heartbeat is the liveness signal (#239 Phase A). relay.lastSeenMs
  // surfaces as the captain's last-seen timestamp so consumers can show age.
  const captainState: HealthState = !relay
    ? "unknown"
    : classifyHealth(relay.lastSeenMs, now, RELAY_STALE_MS, RELAY_GONE_MS) === "gone"
      ? "gone"
      : "alive";
  out.push({
    kind: "captain",
    project,
    ref: captainName,
    state: captainState,
    lastSeenMs: relay?.lastSeenMs ?? null,
    detail: captainState === "gone" ? "captain presumed gone — relay heartbeat dark" : undefined,
  });

  // ── command (on-demand; only surfaced when applicable) ───────────────────
  if (commandPresent !== null) {
    out.push({
      kind: "command",
      project,
      ref: "command",
      state: presence(commandPresent),
      lastSeenMs: null,
    });
  }

  // ── crews (one row per non-terminal crew) ────────────────────────────────
  for (const c of crews) {
    if (TERMINAL.has(c.state)) continue;
    out.push({
      kind: "crew",
      project,
      ref: c.name ?? c.id.slice(0, 8),
      state: classifyHealth(c.lastHeartbeat, now, CREW_STALE_MS, CREW_GONE_MS),
      lastSeenMs: c.lastHeartbeat,
      detail: c.state,
    });
  }

  return out;
}

function presence(p: boolean | null): HealthState {
  if (p === null) return "unknown";
  return p ? "alive" : "gone";
}
