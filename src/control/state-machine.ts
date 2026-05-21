// src/control/state-machine.ts
import type { ControlEvent, TaskRecord, DispatchAttempt } from "./types.js";
import { TERMINAL_STATES } from "./types.js";

/**
 * Pure helper: merges `patch` into the last attempt and updates lastHeartbeatAt.
 * Returns a new TaskRecord; never mutates the input.
 */
function stampAttempt(
  rec: TaskRecord,
  patch: Partial<DispatchAttempt>,
  now: number,
): TaskRecord {
  const attempts = rec.attempts.slice();
  const last = attempts.at(-1) ?? { attemptId: "a0", startedAt: now, lastHeartbeatAt: now };
  attempts[attempts.length === 0 ? 0 : attempts.length - 1] = { ...last, ...patch, lastHeartbeatAt: now };
  if (attempts.length === 0) attempts.push(last);
  return { ...rec, attempts };
}

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
      return {
        ...stampAttempt(base, { pid: ev.pid }, now),
        state: "working",
        pid: ev.pid ?? rec.pid,
        sessionId: ev.sessionId ?? rec.sessionId,
        question: undefined, // resuming after a blocked→reply clears the question
      };
    case "task.progress":
    case "heartbeat":
      // `heartbeat` and `task.progress` intentionally share this case arm
      // (both are liveness signals); split if the watchdog later needs to
      // differentiate them.
      // Anti-#2576: liveness only. A turn-end is NOT completion.
      // From blocked, a bare progress/heartbeat does not auto-unblock
      // (state stays "blocked"); only lastEvent + lastHeartbeat update.
      return rec.state === "blocked"
        ? { ...rec, lastHeartbeat: now, lastEvent: ev.type }
        : base;
    case "task.blocked":
      // ev.reason is protocol/logging-only and intentionally not persisted;
      // only `question` is stored on the record.
      return { ...base, state: "blocked", question: ev.question };
    case "task.done":
      return { ...base, state: "done", resultRef: ev.resultRef, parseWarning: ev.parseWarning };
    case "task.failed":
      return { ...base, state: "failed", error: ev.error, exitCode: ev.exitCode };
    case "task.session":
      return stampAttempt(base, { resumeRef: ev.resumeRef }, now);
    case "task.turn.started":
      return { ...stampAttempt(base, {}, now), state: "working" };
    case "task.turn.completed":
      // Anti-#2576 invariant: TurnCompleted is liveness, NEVER completion. Spec §4.8.
      return { ...stampAttempt(base, {}, now), state: "awaiting-input" };
    case "task.delta":
      return stampAttempt(base, {}, now);  // heartbeat-only
    case "task.input.requested":
    case "task.approval.requested":
      return { ...stampAttempt(base, {}, now), state: "blocked", question: ev.question };
    case "task.reattached":
      return stampAttempt(base, {}, now);
  }
}
