// crew-context-hint.ts — #1015: the `crew send` hint. Hint only; the send always happens.
import type { ContextBudget, TaskRecord } from "@squadrant/shared";
import { formatContext, meterTask } from "@squadrant/core";
import type { ContextMeter } from "@squadrant/core";

/** Pure. One line for the captain when the target crew's context is at/over the crew soft floor, else null. */
export function crewSendHint(name: string, meter: ContextMeter, budget: ContextBudget): string | null {
  if (!budget.enabled || meter === "unknown" || meter.tokens < budget.crewSoft) return null;
  return `crew ${name} at ${formatContext(meter)}; consider 'squadrant crew compact' or a fresh crew with a brief instead of reusing it as is`;
}

/** Meter the crew's task (never throws) and build the hint. `task` is the record `crew send` targets, if known. */
export function hintForCrewSend(name: string, task: TaskRecord | null | undefined, budget: ContextBudget): string | null {
  if (!task) return null;
  try { return crewSendHint(name, meterTask(task), budget); } catch { return null; }
}
