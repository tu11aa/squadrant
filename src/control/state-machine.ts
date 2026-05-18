// src/control/state-machine.ts
import type { ControlEvent, TaskRecord } from "./types.js";
import { TERMINAL_STATES } from "./types.js";

/**
 * Pure transition. `now` is injected (epoch ms) so callers control time.
 * Returns a new record; never mutates the input.
 */
export function reduce(rec: TaskRecord, ev: ControlEvent, now: number): TaskRecord {
  // Terminal states are absorbing: ignore any late/duplicate event idempotently.
  if (TERMINAL_STATES.has(rec.state)) return rec;

  const base = { ...rec, lastHeartbeat: now, lastEvent: ev.type };

  switch (ev.type) {
    case "task.started":
      return { ...base, state: "working", pid: ev.pid ?? rec.pid, sessionId: ev.sessionId ?? rec.sessionId };
    case "task.progress":
    case "heartbeat":
      // Anti-#2576: liveness only. A turn-end is NOT completion.
      // From blocked, a bare progress/heartbeat does not auto-unblock.
      return rec.state === "blocked" ? { ...rec, lastHeartbeat: now } : base;
    case "task.blocked":
      return { ...base, state: "blocked", question: ev.question };
    case "task.done":
      return { ...base, state: "done", resultRef: ev.resultRef, parseWarning: ev.parseWarning };
    case "task.failed":
      return { ...base, state: "failed", error: ev.error, exitCode: ev.exitCode };
  }
}
