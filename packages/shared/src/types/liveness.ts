export type Role = "captain" | "crew" | "command";
export type LivenessSource = "runtime" | "agent" | "scan";

/** Persisted per-component liveness fact. */
export interface LivenessEntry {
  project: string;
  role: Role;
  pid: number | null;
  sessionId: string;
  startedAt: number;
  /** intent: process opened vs cleanly closed. */
  lastState: "start" | "end";
  lastSeenAt: number;
  /** liveness axis — written only by the pid floor. */
  pidAlive: boolean;
  source: LivenessSource;
}

/** One ground-truth record from a runtime's own session store (§5.4). */
export interface RuntimeLivenessRecord {
  role: Role | "unknown";
  project: string;
  pid: number | null;
  sessionId: string;
  present: boolean;
  isRestorable?: boolean;
}
