// src/control/types.ts
export type Provider = "claude" | "opencode" | "codex" | "gemini";
export type Mode = "headless" | "interactive";

export type TaskState =
  | "submitted"
  | "working"
  | "blocked"
  | "done"
  | "failed"
  | "stalled"
  | "awaiting-input"
  | "cancelled";

export interface DispatchAttempt {
  attemptId: string;
  startedAt: number;
  pid?: number;
  resumeRef?: string;       // opaque, hashed-treated, NEVER parsed (orca #1148)
  lastHeartbeatAt: number;
  error?: string;
  exitCode?: number;
  circuitBroken?: boolean;
}

export interface Gate {
  gateId: string;
  taskId: string;
  kind: "input" | "approval";
  question: string;
  state: "pending" | "resolved" | "timeout";
  createdAt: number;
  resolvedBy?: string;
  resolution?: unknown;
}

export interface TaskRecord {
  id: string;
  /** Human-readable crew name (e.g. the `--name` arg to `cockpit crew spawn`).
   *  Optional for backward-compat with records written before this field
   *  existed; relay/daemon fall back to the short id when absent. */
  name?: string;
  project: string;
  provider: Provider;
  mode: Mode;
  state: TaskState;
  task: string;            // the dispatched instruction
  sessionId?: string;      // provider session id for resume (blocked→reply)
  cwd?: string;            // working dir for the spawned headless child (project/worktree); unset → daemon cwd
  pid?: number;            // headless child pid (daemon-owned)
  question?: string;       // populated when state === "blocked"
  error?: string;          // populated when state === "failed"
  exitCode?: number;
  resultRef?: string;      // filesystem path to captured output/artifact
  parseWarning?: boolean;  // headless exit 0 but unparseable result
  createdAt: number;       // epoch ms
  lastHeartbeat: number;   // epoch ms
  lastEvent: string;       // last event type applied
  heartbeatBudgetMs: number; // per-task stall threshold
  /** Append-only dispatch attempt history. Current attempt = at(-1). */
  attempts: DispatchAttempt[];
  /** Interactive-codex HITL slice (spec §4.9). */
  gates?: Gate[];
  /** Codex AskForApproval policy forwarded to startThread (interactive only).
   *  When set to "untrusted", codex requests approval for tool/shell calls,
   *  exercising the gate-promotion flow end-to-end. */
  approvalPolicy?: string;
  /** Role-priming content forwarded to startThread's developerInstructions
   *  (interactive only). Parity with claude's --append-system-prompt-file:
   *  injects crew rules / Karpathy discipline before the first user turn. */
  roleInstructions?: string;
}

export type ControlEvent =
  | { type: "task.started"; id: string; pid?: number; sessionId?: string }
  | { type: "task.progress"; id: string; note?: string }
  | { type: "heartbeat"; id: string }
  | { type: "task.blocked"; id: string; reason: string; question: string }
  | { type: "task.done"; id: string; resultRef: string; message?: string; parseWarning?: boolean }
  | { type: "task.failed"; id: string; error: string; exitCode?: number }
  | { type: "task.session"; id: string; resumeRef: string }
  | { type: "task.turn.started"; id: string; turnId: string }
  | { type: "task.turn.completed"; id: string; turnId: string }
  | { type: "task.delta"; id: string; turnId: string; chunk: string }
  | { type: "task.input.requested"; id: string; requestId: number; question: string }
  | { type: "task.approval.requested"; id: string; requestId: number; question: string; kind: string }
  | { type: "task.reattached"; id: string }
  // Reopen: the only event allowed to revive a terminal task. Emitted by
  // `cockpit crew send` when the target crew's daemon task is in a terminal
  // state, allowing the next `signal done` to be a real transition.
  | { type: "task.reopened"; id: string }
  // Synthetic events: emitted by the daemon (watchdog / reconcile) purely as
  // notify payloads. They are never sent over the wire and the reducer treats
  // them as no-ops; the watchdog has already updated state directly.
  | { type: "task.stalled"; id: string; heartbeatBudgetMs: number }
  // task.idle is the interactive analogue of task.stalled: the watchdog has
  // already moved an idle interactive task to 'awaiting-input', and this carries
  // the accurate (non-alarming) notify payload to the captain.
  | { type: "task.idle"; id: string; heartbeatBudgetMs: number }
  | { type: "task.reconcile-failed"; id: string; reason: string }
  // Emitted by runCrewClose before closing the pane; transitions a non-terminal
  // task to the absorbing 'cancelled' state. Silent: captain initiated the close
  // so no CREW CANCELLED push is fired (not in ATTENTION_STATES).
  | { type: "task.cancelled"; id: string; reason?: string };

// 'stalled' is intentionally excluded — recoverable by the watchdog.
// 'cancelled' is terminal and silent (captain-initiated close).
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "done",
  "failed",
  "cancelled",
]);
