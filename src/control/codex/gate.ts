// src/control/codex/gate.ts
// Pure helpers for the interactive-codex HITL gate primitive (spec §4.9).
import type { Gate } from "../types.js";

export function makeGate(opts: {
  taskId: string;
  kind: "input" | "approval";
  question: string;
  now: number;
  mkId: () => string;
}): Gate {
  return {
    gateId: opts.mkId(),
    taskId: opts.taskId,
    kind: opts.kind,
    question: opts.question,
    state: "pending",
    createdAt: opts.now,
  };
}

export function resolveGate(g: Gate, by: { resolvedBy: string; resolution: unknown }): Gate {
  return { ...g, state: "resolved", resolvedBy: by.resolvedBy, resolution: by.resolution };
}

export function timeoutGate(g: Gate): Gate {
  return { ...g, state: "timeout" };
}
