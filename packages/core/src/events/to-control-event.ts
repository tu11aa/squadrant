/**
 * PURE. The one place a fact becomes a ControlEvent.
 *
 * CRITICAL: this must reproduce exactly what today's direct producers emit.
 * Any divergence shows up as a shadow-mode disagreement and hides real
 * regressions. Correlation ids (turnId, requestId) travel ON the fact for
 * exactly this reason — regenerating them would differ every run.
 *
 * NEVER emits task.blocked: its existing producers keep that job (spec §3).
 */
import type { ControlEvent } from "@squadrant/shared";
import type { AgentFact } from "./fact.js";

/** Facts that would terminalise. An inferred fact may never do this alone. */
const TERMINALISING: ReadonlySet<string> = new Set(["session.ended"]);

export function toControlEvent(fact: AgentFact): ControlEvent[] {
  // I4 enforced at the boundary, not merely reported: a pane-scraped fact
  // cannot terminalise a live crew (#704).
  if (fact.origin === "inferred" && TERMINALISING.has(fact.kind)) return [];

  switch (fact.kind) {
    case "turn.ended":
      return [{ type: "task.turn.completed", id: fact.taskId, turnId: fact.turnId ?? fact.source }];

    case "permission.requested":
      return [{
        type: "task.approval.requested",
        id: fact.taskId,
        requestId: fact.requestId,
        question: fact.question,
        kind: fact.tool,
      }];

    case "input.requested":
      return [{
        type: "task.input.requested",
        id: fact.taskId,
        requestId: fact.requestId,
        question: fact.question,
      }];

    case "session.ended":
      return [{ type: "task.session.ended", id: fact.taskId }];

    case "session.started":
      return [{
        type: "task.started",
        id: fact.taskId,
        ...(fact.pid === undefined ? {} : { pid: fact.pid }),
        ...(fact.sessionId === undefined ? {} : { sessionId: fact.sessionId }),
      }];

    case "prompt.submitted":
      return [{ type: "task.first-turn.confirmed", id: fact.taskId }];

    // Liveness-only. The facade still feeds these to reduceLifecycle; they
    // simply carry no ControlEvent of their own.
    case "tool.opened":
    case "tool.closed":
    case "activity":
    case "process.observed":
    case "unknown":
      return [];
  }
}
