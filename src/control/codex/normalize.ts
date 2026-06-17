// src/control/codex/normalize.ts
// Pure mapping from app-server ServerNotification → cockpit ControlEvent.
// Spec §4.7. Unknown methods return null (status-line only / forward-compat).
//
// Anti-#2576 invariant: NO codex notification maps to task.done.
// task.done is emitted exclusively by the driver on clean process exit.
//
// NOTE: Server-requests (frames that carry an `id` field alongside `method`)
// are NOT handled here — they are routed by CodexInteractiveDriver (Task 2.4).
// Extending this function with request handling would be incorrect.
import type { ControlEvent } from "@cockpit/shared";

/** Minimal shape accepted from the JSON-RPC notification stream. */
export type AppServerNotification = { method: string; params?: Record<string, unknown> };

/**
 * Map one app-server notification to a ControlEvent, or null when the
 * notification is informational (token-usage, compaction, status-change)
 * and does not need to enter the cockpit event bus.
 *
 * @param taskId  The cockpit task ID that owns this notification stream.
 * @param n       Raw notification frame from the app-server JSON-RPC channel.
 */
export function normalizeAppServerNotification(
  taskId: string,
  n: AppServerNotification,
): ControlEvent | null {
  const p = n.params ?? {};

  switch (n.method) {
    // ── turn lifecycle ────────────────────────────────────────────────────
    case "turn/started":
      return {
        type: "task.turn.started",
        id: taskId,
        // TurnStartedNotification carries params.turn.id, not a top-level turnId.
        turnId: String((p["turn"] as Record<string, unknown>)?.["id"] ?? ""),
      };

    case "turn/completed":
      return {
        type: "task.turn.completed",
        id: taskId,
        // TurnCompletedNotification: same shape as TurnStartedNotification.
        turnId: String((p["turn"] as Record<string, unknown>)?.["id"] ?? ""),
      };

    // ── streaming delta (heartbeat / content) ─────────────────────────────
    // AgentMessageDeltaNotification: { threadId, turnId, itemId, delta }
    case "item/agentMessage/delta":
    // ReasoningTextDeltaNotification: { threadId, turnId, itemId, delta, contentIndex }
    case "item/reasoning/textDelta":
    // CommandExecutionOutputDeltaNotification: { threadId, turnId, itemId, delta }
    case "item/commandExecution/outputDelta":
      return {
        type: "task.delta",
        id: taskId,
        turnId: String(p["turnId"] ?? ""),
        chunk: String(p["delta"] ?? ""),
      };

    // command/exec/outputDelta is connection-scoped (no turnId); map to delta
    // with empty turnId so the bus can still forward it.
    // CommandExecOutputDeltaNotification: { processId, stream, deltaBase64, capReached }
    case "command/exec/outputDelta":
      return {
        type: "task.delta",
        id: taskId,
        turnId: "",
        chunk: String(p["deltaBase64"] ?? ""),
      };

    // ── error ─────────────────────────────────────────────────────────────
    // ErrorNotification: { error: TurnError, willRetry, threadId, turnId }
    case "error": {
      const err = p["error"] as Record<string, unknown> | undefined;
      const message = String(err?.["message"] ?? p["message"] ?? "error");
      return { type: "task.failed", id: taskId, error: message };
    }

    // ── status-line only — return null ────────────────────────────────────
    // ThreadTokenUsageUpdatedNotification: { threadId, turnId, tokenUsage }
    case "thread/tokenUsage/updated":
    // ContextCompactedNotification (deprecated): { threadId, turnId }
    case "thread/compacted":
    // ThreadStatusChangedNotification
    case "thread/status/changed":
      return null;

    // ── unknown / future methods ──────────────────────────────────────────
    default:
      return null;
  }
}
