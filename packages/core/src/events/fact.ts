/**
 * The one vocabulary every observed agent signal is translated into.
 * Adapters translate; they never classify-and-discard. An unrecognised frame
 * becomes { kind: "unknown" } and is counted — see spec §5.
 */

export type FactSource =
  | "cmux-events" | "claude-hook" | "claude-peer"
  | "cmux-scan"   | "pane"        | "opencode-sse";

/** Trust rank. Declared once per adapter so an adapter cannot lie about it. */
export type FactOrigin = "agent" | "scan" | "inferred";

/** The identity fields the facade owns. An adapter never sets these. */
export interface FactIdentity {
  seq: number;
  taskId: string;
  at: number;
  source: FactSource;
  origin: FactOrigin;
}

/** The payload half — what an adapter produces. */
export type RawFact =
  | { kind: "session.started";      pid?: number; sessionId?: string }
  | { kind: "session.ended" }
  | { kind: "prompt.submitted" }
  | { kind: "turn.ended";           turnId?: string }
  | { kind: "tool.opened";          tool: string }
  | { kind: "tool.closed";          tool?: string }
  | { kind: "input.requested";      question: string; requestId: number }
  | { kind: "permission.requested"; question: string; requestId: number; tool: string }
  | { kind: "activity" }
  | { kind: "process.observed";     alive: boolean; pid?: number }
  | { kind: "unknown";              name: string };

export type AgentFact = RawFact & FactIdentity;
export type FactKind = RawFact["kind"];

/**
 * The seam. One file per signal source; that file is all a new agent needs.
 */
export interface FactAdapter {
  readonly name: FactSource;
  /** Trust rank for every fact this adapter produces. */
  readonly origin: FactOrigin;
  /**
   * Translate one raw frame into zero or more facts.
   * MUST NOT throw. MUST NOT return null/undefined.
   * An unrecognised frame MUST yield [{ kind: "unknown", name }].
   */
  translate(raw: unknown): RawFact[];
}

/** Attach facade-owned identity. Identity always wins over anything on `raw`. */
export function stampFact(raw: RawFact, id: FactIdentity): AgentFact {
  return { ...raw, ...id };
}
