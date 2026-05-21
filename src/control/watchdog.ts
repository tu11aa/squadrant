// src/control/watchdog.ts
import type { TaskRecord } from "./types.js";

/**
 * Pure. Returns a stalled record if a `working` task has exceeded its
 * heartbeat budget at time `now` (epoch ms), else null. No I/O, no clock.
 *
 * Policy: `stalled` is RECOVERABLE, not terminal (spec §4.8, #90).
 * Interactive-codex tasks in particular surface to the Captain via the
 * 'stalled' state and remain answerable; this function never produces
 * `failed` directly.
 */
export function evaluateStall(rec: TaskRecord, now: number): TaskRecord | null {
  if (rec.state !== "working") return null;
  if (now - rec.lastHeartbeat <= rec.heartbeatBudgetMs) return null;
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
