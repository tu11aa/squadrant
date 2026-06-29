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
  /** Human-readable crew name (e.g. the `--name` arg to `squadrant crew spawn`).
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
  /** TCP port of an interactive opencode crew's embedded HTTP server
   *  (`opencode --port <N>`). The daemon's SSE bridge subscribes to
   *  http://127.0.0.1:<serverPort>/event for reliable turn-end detection. */
  serverPort?: number;
  /** #246: cross-project intra-group delegation — set to the origin project's
   *  name when this task was dispatched by a sibling captain. When the task
   *  settles, the daemon fans the outcome back to originProject's mailbox. */
  originProject?: string;
  /** #354: the tool call currently in flight, if any. Set when a PreToolUse
   *  liveness signal arrives (cmux events-bridge carries the tool name); cleared
   *  the moment its PostToolUse / next turn boundary arrives. A `working` crew
   *  whose pendingTool has been outstanding past TOOL_STALL_BUDGET_MS is treated
   *  as hung-on-a-tool (CREW STALLED warn) — distinct from a quiet thinking turn
   *  (no pendingTool → CREW QUIET). Auto-clears: the next PostToolUse recovers
   *  the record to `working` (state-machine + recoverStall). */
  pendingTool?: { name: string; since: number };
  /** #466: epoch ms when the spawn path positively confirmed the first turn was
   *  delivered (paste rendered in the box → box emptied = submitted). Unset means
   *  either the crew was spawned before this field existed, OR delivery was never
   *  confirmed. The watchdog uses this to emit CREW UNDELIVERED instead of the
   *  misleading "deep thinking" message for a crew that never received its task. */
  firstTurnConfirmedAt?: number;
}

export type ControlEvent =
  | { type: "task.started"; id: string; pid?: number; sessionId?: string }
  | { type: "task.progress"; id: string; note?: string; tool?: string }
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
  // `squadrant crew send` when the target crew's daemon task is in a terminal
  // state, allowing the next `signal done` to be a real transition.
  | { type: "task.reopened"; id: string }
  // Synthetic events: emitted by the daemon (watchdog / reconcile) purely as
  // notify payloads. They are never sent over the wire and the reducer treats
  // them as no-ops; the watchdog has already updated state directly.
  // #354: `tool`/`elapsedMs` are set when the stall is a hung interactive tool
  // call (PreToolUse with no matching PostToolUse past TOOL_STALL_BUDGET_MS),
  // letting the notifier render "still running {tool} ~{N}min" instead of the
  // generic headless "no heartbeat" message.
  | { type: "task.stalled"; id: string; heartbeatBudgetMs: number; tool?: string; elapsedMs?: number }
  // task.idle is the interactive analogue of task.stalled: the watchdog has
  // already moved an idle interactive task to 'awaiting-input', and this carries
  // the accurate (non-alarming) notify payload to the captain.
  | { type: "task.idle"; id: string; heartbeatBudgetMs: number }
  // #354: a `working` interactive crew that has been quiet past its heartbeat
  // budget with NO tool in flight — alive but deep-thinking (no hook fires
  // during pure model thinking). Notify-only (reducer no-op): the crew stays
  // `working`, NOT awaiting-input. Real CREW IDLE still comes only from the Stop
  // hook (a genuine turn-end). `quietMs` = how long it has been silent.
  | { type: "task.quiet"; id: string; quietMs: number }
  // #225: emitted by the sweep when a task's wall-clock age exceeds the ceiling.
  // Notify-only (detect-first, #77); reducer is a no-op.
  | { type: "task.timeout"; id: string; taskTimeoutMs: number }
  | { type: "task.reconcile-failed"; id: string; reason: string }
  // Emitted by runCrewClose before closing the pane; transitions a non-terminal
  // task to the absorbing 'cancelled' state. Silent: captain initiated the close
  // so no CREW CANCELLED push is fired (not in ATTENTION_STATES).
  | { type: "task.cancelled"; id: string; reason?: string }
  // #466: emitted by runCrewSpawn after positively confirming the first turn was
  // delivered. Stamps firstTurnConfirmedAt on the record so the watchdog can
  // distinguish a quiet-thinking crew from one that never received its task.
  | { type: "task.first-turn.confirmed"; id: string }
  // #139: a claude crew's SessionEnd hook fired — the session is GONE. Unlike
  // the other turn-boundary hooks (PostToolUse/SubagentStop = liveness), a dead
  // session must NOT resume 'working' (nothing heartbeats → false CREW STALLED
  // ~budget later). Terminalizes the record to the absorbing 'cancelled' state.
  // Silent (not in ATTENTION_STATES), like task.cancelled.
  | { type: "task.session.ended"; id: string };

// 'stalled' is intentionally excluded — recoverable by the watchdog.
// 'cancelled' is terminal and silent (captain-initiated close).
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "done",
  "failed",
  "cancelled",
]);
