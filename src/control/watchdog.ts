// src/control/watchdog.ts
import type { TaskRecord } from "@cockpit/shared";

/**
 * Pure. Returns an idle-transitioned record if a `working` task has exceeded
 * its heartbeat budget at time `now` (epoch ms), else null. No I/O, no clock.
 *
 * Mode decides what "idle" means:
 *  - interactive → 'awaiting-input'. An idle interactive crew has merely ended
 *    a turn and is awaiting the captain's next message — answerable, NOT a
 *    failure. This reframes the old interactive-codex 'stalled' surfacing
 *    (#90 "warn-don't-autofail", spec §4.8) into an explicitly answerable
 *    state that reads as normal idle and resumes to 'working' on next liveness.
 *  - headless → 'stalled'. A batch child that stops heartbeating is genuinely
 *    stuck; there is no captain turn to await, so surface it as a stall.
 *
 * Neither state is terminal; this function never produces `failed` directly.
 */
export function evaluateStall(rec: TaskRecord, now: number): TaskRecord | null {
  if (rec.state !== "working") return null;
  // Key off the latest attempt's lastHeartbeatAt so a stale event from a dead
  // prior attempt cannot refresh the liveness clock of the new dispatch (#89).
  const liveness = rec.attempts.at(-1)?.lastHeartbeatAt ?? rec.lastHeartbeat;
  if (now - liveness <= rec.heartbeatBudgetMs) return null;
  if (rec.mode === "interactive") {
    return { ...rec, state: "awaiting-input", lastEvent: "watchdog.idle" };
  }
  return { ...rec, state: "stalled", lastEvent: "watchdog.stall" };
}

/**
 * Pure. A stalled task that receives liveness returns to working.
 *
 * WARNING: this does NOT check heartbeat freshness — it returns a recovered
 * record for ANY stalled task. Callers MUST guard with
 * `now - rec.lastHeartbeat <= rec.heartbeatBudgetMs` before applying the
 * result, or a permanently-stale task will be falsely revived.
 */
export function recoverStall(rec: TaskRecord, now: number): TaskRecord | null {
  if (rec.state !== "stalled") return null;
  return { ...rec, state: "working", lastHeartbeat: now, lastEvent: "watchdog.recover" };
}
