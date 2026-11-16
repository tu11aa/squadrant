// crew-context-hint.ts — #1015 hint, #1126 gate: what `crew send` says (or refuses) from the target crew's context. Never compacts.
import { TERMINAL_STATES } from "@squadrant/shared";
import type { ContextBudget, TaskRecord } from "@squadrant/shared";
import { formatContext, meterTask } from "@squadrant/core";

export interface SendCheck {
  /** Set ⇒ the send must not happen (a reopening send above the gate, no override). */
  refuse?: string;
  /** One-time warning line. */
  hint?: string;
  /** Task id whose one-time warning was just issued; the caller records it. */
  warned?: string;
}

/**
 * Pure. Tiers by live context: below `crewSoft` silent; from `crewSoft` ONE warning per task (the caller persists
 * `warned`); a send that REOPENS a terminal task at/above `crewGate` is refused unless `noCompact`. Sends to a live
 * crew are never gated. Unmeasurable context (non-claude) is silent.
 */
export function checkCrewSend(
  project: string, name: string, task: TaskRecord, tokens: number | null, budget: ContextBudget,
  opts: { noCompact?: boolean; alreadyWarned: boolean },
): SendCheck {
  if (!budget.enabled || tokens === null || tokens < budget.crewSoft) return {};
  const ctx = formatContext({ tokens, measuredAt: 0 });
  const compact = `squadrant crew compact ${project} ${name} --keep '…'`;
  if (TERMINAL_STATES.has(task.state) && tokens >= budget.crewGate && !opts.noCompact) {
    return {
      refuse:
        `crew ${name} is at ${ctx} ctx; compact first: ${compact}. This send would start a new round on it (operator rule: compact before a crew's next task; never auto-compact). ` +
        `Pass --no-compact (MCP: no_compact) to reuse it as is.`,
    };
  }
  if (opts.alreadyWarned) return {};
  return {
    hint: `crew ${name} at ${ctx}; compact it before its next new task: ${compact} (a send that reopens it is refused from ${formatContext({ tokens: budget.crewGate, measuredAt: 0 })}). Shown once per task.`,
    warned: task.id,
  };
}

/** Meter the crew's task (never throws; null when unmeasurable). */
export function crewTokens(task: TaskRecord): number | null {
  try { const m = meterTask(task); return m === "unknown" ? null : m.tokens; } catch { return null; }
}
