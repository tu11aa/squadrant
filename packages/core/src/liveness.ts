// src/control/liveness.ts
//
// PURE service-health layer (no I/O, no clock) — the #77 foundation. Mirrors
// watchdog.ts: every function derives a verdict from records + an explicit `now`
// so it is fully unit-testable. All runtime probing (cmux reads for captain
// presence) is gathered by the caller (cockpitd) and passed in already-resolved;
// this module never touches cmux.
import type { TaskState, Mode } from "@cockpit/shared";

export type ComponentKind = "captain" | "crew" | "command";

// alive   = seen within the stale window (healthy)
// stale   = quiet past stale but not yet gone (degrading)
// gone    = dark past the gone window (treat as down — a FAULT)
// stopped = intentionally offline (user closed the captain workspace) — NOT a
//           fault. Distinct from `gone` so the surface never red-alarms an
//           expected shutdown (#324/#323).
// unknown = no signal / not applicable (never alarms)
export type HealthState = "alive" | "stale" | "gone" | "stopped" | "unknown";

export interface ComponentHealth {
  kind: ComponentKind;
  project: string;
  /** crew name / captain name / "command". */
  ref: string;
  state: HealthState;
  /** epoch ms of last evidence of life, or null when there is no timestamp
   *  source (captain/command presence is a boolean, not a heartbeat). */
  lastSeenMs: number | null;
  /** human-facing context — e.g. a recovery command. */
  detail?: string;
}

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
 * Emits: a captain row, a command row (only when applicable), and one row per
 * non-terminal crew.
 *
 * Captain liveness (#332): driven by the daemon-direct delivery loop.
 *   captainStopped === false  → captain surface was found on last delivery tick → ALIVE
 *   captainStopped === true   → surface gone for 3+ consecutive ticks → STOPPED
 *                               (intentional close — its crews are reaped and
 *                               delivery is paused; NOT a fault — #324/#323)
 *   captainStopped === null   → not yet checked / cmux unreachable → UNKNOWN
 */
export function projectHealth(input: {
  project: string;
  now: number;
  captainName: string;
  /** Delivery-loop captain surface state. See docs above. */
  captainStopped: boolean | null;
  /** true/false when a command workspace is expected; null = not applicable. */
  commandPresent: boolean | null;
  crews: CrewLiveness[];
}): ComponentHealth[] {
  const { project, now, captainName, captainStopped, commandPresent, crews } = input;
  const out: ComponentHealth[] = [];

  // ── captain ────────────────────────────────────────────────────────────
  const captainState: HealthState =
    captainStopped === true ? "stopped" :
    captainStopped === false ? "alive" :
    "unknown";
  out.push({
    kind: "captain",
    project,
    ref: captainName,
    state: captainState,
    lastSeenMs: null,
    detail: captainState === "stopped" ? "captain workspace closed — crews reaped; delivery paused" : undefined,
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

/** Human-friendly age of the last-seen timestamp, or em-dash when there is none. */
export function ageText(lastSeenMs: number | null, now: number): string {
  if (lastSeenMs == null) return "—";
  const s = Math.max(0, Math.round((now - lastSeenMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/**
 * Pure. Return the heal command string for a component that needs remediation,
 * or null when no action is needed (or when no heal verb exists for this kind).
 */
export function healCmdFor(c: ComponentHealth): string | null {
  // No heal verb for captain/crew — daemon-direct delivery handles recovery automatically.
  return null;
}

/** Per-project relay health — REMOVED (#332). No longer tracked by daemon. */
export type RelayHealth = never;
