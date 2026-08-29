/**
 * PURE relational checks over one crew's fact stream. No clock, no fs — time
 * arrives as fact.at, which is what makes fixture replay deterministic.
 *
 * Deliberately NOT checked: "seq strictly increases". The facade stamps seq, so
 * it always does — the invariant would be vacuous (spec §7).
 */
import type { AgentFact, FactSource } from "./fact.js";

export type ViolationCode = "I1" | "I2" | "I3" | "I4" | "I5" | "I6";

export interface Violation {
  code: ViolationCode;
  message: string;
  taskId: string;
  at: number;
}

export interface CrewTrace {
  /** Open tool calls. No call id exists in any payload, so we count (spec §5). */
  depth: number;
  /** `at` of the oldest currently-open tool, for I3. */
  oldestOpenAt: number | null;
  /** Suppresses repeat I3 reports for one open window. */
  stallReported: boolean;
  /** Count of unrecognised frames seen, for operator-facing metrics. */
  unknownSeen: number;
  /** Last liveness claim per source, for I6. */
  liveness: Map<FactSource, { alive: boolean; at: number }>;
}

export interface CheckOptions {
  /** I3 threshold. Omitted disables I3. */
  stallBudgetMs?: number;
  /** I6 window. Omitted disables I6. Spec §7 default: 5000. */
  disagreeWindowMs?: number;
}

export function freshTrace(): CrewTrace {
  return {
    depth: 0,
    oldestOpenAt: null,
    stallReported: false,
    unknownSeen: 0,
    liveness: new Map(),
  };
}

const v = (code: ViolationCode, message: string, f: AgentFact): Violation =>
  ({ code, message, taskId: f.taskId, at: f.at });

/** Facts that would terminalise a crew if acted on alone (spec §7, I4). */
const TERMINALISING: ReadonlySet<string> = new Set(["session.ended"]);

/** Advance `trace` by one fact and return any violations that fact caused. */
export function checkFact(
  trace: CrewTrace,
  fact: AgentFact,
  opts: CheckOptions,
): Violation[] {
  const out: Violation[] = [];

  if (fact.origin === "inferred" && TERMINALISING.has(fact.kind)) {
    out.push(v("I4", `inferred fact "${fact.kind}" from ${fact.source} cannot terminalise alone`, fact));
  }

  switch (fact.kind) {
    case "tool.opened":
      if (trace.depth === 0) {
        trace.oldestOpenAt = fact.at;
        trace.stallReported = false;
      }
      trace.depth += 1;
      break;

    case "tool.closed":
      if (trace.depth === 0) {
        out.push(v("I1", `tool.closed from ${fact.source} with no open tool`, fact));
      } else {
        trace.depth -= 1;
        if (trace.depth === 0) {
          trace.oldestOpenAt = null;
          trace.stallReported = false;
        }
      }
      break;

    case "turn.ended":
      if (trace.depth > 0) {
        out.push(v("I2", `turn.ended with ${trace.depth} tool call(s) still open`, fact));
        // Reset so one lost close does not poison every later turn.
        trace.depth = 0;
        trace.oldestOpenAt = null;
        trace.stallReported = false;
      }
      break;

    case "unknown":
      trace.unknownSeen += 1;
      out.push(v("I5", `unrecognised frame "${fact.name}" from ${fact.source}`, fact));
      break;

    case "process.observed": {
      const prior = [...trace.liveness.entries()].find(
        ([src, s]) =>
          src !== fact.source &&
          s.alive !== fact.alive &&
          fact.at - s.at <= (opts.disagreeWindowMs ?? -1),
      );
      if (prior) {
        out.push(v(
          "I6",
          `liveness disagreement: ${prior[0]} said alive=${prior[1].alive}, ` +
          `${fact.source} says alive=${fact.alive}`,
          fact,
        ));
      }
      trace.liveness.set(fact.source, { alive: fact.alive, at: fact.at });
      break;
    }

    default:
      break;
  }

  // I3 is time-based and evaluated on every fact, not only tool facts.
  if (
    opts.stallBudgetMs !== undefined &&
    trace.depth > 0 &&
    trace.oldestOpenAt !== null &&
    !trace.stallReported &&
    fact.at - trace.oldestOpenAt > opts.stallBudgetMs
  ) {
    trace.stallReported = true;
    out.push(v("I3", `tool open for ${fact.at - trace.oldestOpenAt}ms, past the stall budget`, fact));
  }

  return out;
}
