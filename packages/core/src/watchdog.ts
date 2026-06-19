// src/control/watchdog.ts
import type { TaskRecord } from "@cockpit/shared";

/**
 * #354: how long an interactive tool call may be in flight before it is treated
 * as hung. Deliberately generous (much larger than the 5-min heartbeat budget)
 * so a legitimately long tool — a multi-minute test suite, a big build, a slow
 * git/network op — does NOT trip it: those are real, recoverable work, and the
 * matching PostToolUse auto-clears the warn the instant it returns. Only a tool
 * that produces no result for this long is suspicious enough to surface as
 * "possibly hung". Default 10 min; tune via evaluateStall's `toolStallMs`.
 */
export const TOOL_STALL_BUDGET_MS = 10 * 60 * 1000;

/**
 * Pure. Returns a stalled-transitioned record if a `working` task is genuinely
 * stuck at time `now` (epoch ms), else null. No I/O, no clock. #354 splits the
 * old single wall-clock timeout by what we can actually prove:
 *
 *  - headless → 'stalled' once quiet past the heartbeat budget. A batch child
 *    that stops emitting stdout is stuck; there is no captain turn to await.
 *  - interactive WITH a tool in flight (pendingTool) → 'stalled' once that tool
 *    has been outstanding past `toolStallMs`. A PreToolUse with no matching
 *    PostToolUse is a hung tool call (we know which tool). Recoverable: the next
 *    PostToolUse recovers it to `working` (state-machine / recoverStall).
 *  - interactive with NO tool in flight → null. A quiet thinking turn is alive,
 *    not stalled and NOT awaiting-input (the turn never ended — real CREW IDLE
 *    comes only from the Stop hook). The daemon sweep surfaces this as a
 *    distinct, non-alarming CREW QUIET notify instead (#354), keeping the crew
 *    `working`. This replaces the old wall-clock → 'awaiting-input' flip, which
 *    mislabeled deep-thinking crews as "awaiting your input".
 *
 * This function never produces `failed` or `awaiting-input` directly.
 */
export function evaluateStall(
  rec: TaskRecord,
  now: number,
  toolStallMs: number = TOOL_STALL_BUDGET_MS,
): TaskRecord | null {
  if (rec.state !== "working") return null;
  if (rec.mode === "interactive") {
    // Only a hung tool call is a stall for an interactive crew; a quiet thinking
    // turn (no pendingTool) is alive and handled by the sweep's CREW QUIET path.
    if (!rec.pendingTool) return null;
    if (now - rec.pendingTool.since <= toolStallMs) return null;
    return { ...rec, state: "stalled", lastEvent: "watchdog.tool-stall" };
  }
  // headless: key off the latest attempt's lastHeartbeatAt so a stale event from
  // a dead prior attempt cannot refresh the liveness clock of the new dispatch (#89).
  const liveness = rec.attempts.at(-1)?.lastHeartbeatAt ?? rec.lastHeartbeat;
  if (now - liveness <= rec.heartbeatBudgetMs) return null;
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
  // #354: clear any hung-tool marker on recovery so a recovered crew never
  // carries a stale pendingTool into its next quiet window.
  return { ...rec, state: "working", lastHeartbeat: now, lastEvent: "watchdog.recover", pendingTool: undefined };
}
