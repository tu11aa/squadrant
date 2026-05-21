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
  | "awaiting-input";

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
}

export type ControlEvent =
  | { type: "task.started"; id: string; pid?: number; sessionId?: string }
  | { type: "task.progress"; id: string; note?: string }
  | { type: "heartbeat"; id: string }
  | { type: "task.blocked"; id: string; reason: string; question: string }
  | { type: "task.done"; id: string; resultRef: string; parseWarning?: boolean }
  | { type: "task.failed"; id: string; error: string; exitCode?: number }
  | { type: "task.session"; id: string; resumeRef: string }
  | { type: "task.turn.started"; id: string; turnId: string }
  | { type: "task.turn.completed"; id: string; turnId: string }
  | { type: "task.delta"; id: string; turnId: string; chunk: string }
  | { type: "task.input.requested"; id: string; requestId: number; question: string }
  | { type: "task.approval.requested"; id: string; requestId: number; question: string; kind: string }
  | { type: "task.reattached"; id: string };

// 'stalled' is intentionally excluded — recoverable by the watchdog.
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "done",
  "failed",
]);
