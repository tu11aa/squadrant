// #890: when captain delivery recovers (reconnect, relaunch, unstick) the
// pending mailbox backlog used to replay one entry at a time, in seq order, as
// if every event were fresh — hours-old CREW QUIET/IDLE/REVIEW for a crew that
// had since finished, an obsolete DELIVERY STUCK alert, an old CREW DONE.
// coalesceBacklog looks at the whole pending backlog at once and decides, per
// entry, whether it still says something true:
//   - superseded transients are dropped (a newer event for the same task is
//     queued behind them);
//   - entries for a task that has since gone terminal are annotated (or, for
//     pure transients, dropped);
//   - entries older than STALE_ALERT_THRESHOLD_MS get the "[stale — …]" prefix;
//   - daemon DELIVERY STUCK self-alerts are dropped: the loop only reaches one
//     after the entry it was about has been acked, so it is no longer true.
// Must-deliver kinds (#474/#531) are never dropped — at most annotated.
import { TERMINAL_STATES, type TaskState } from "@squadrant/shared";
import type { MailboxEntry } from "../mailbox.js";
import { stalePrefix } from "./down-alert.js";

export type BacklogDecision =
  | { action: "deliver"; entry: MailboxEntry }
  | { action: "skip"; entry: MailboxEntry; reason: "superseded" | "task-terminal" | "moot-stuck-alert" };

// Transient kinds that any newer event for the same task makes moot.
const TRANSIENT_KINDS = new Set(["task.quiet", "task.turn.completed"]);
// Kind → the terminal state it announces.
const TERMINAL_EVENT_STATE: Record<string, TaskState> = {
  "task.done": "done", "task.failed": "failed", "task.cancelled": "cancelled",
};
// The STUCK_ALERT_TEXT family in delivery-loop.ts.
const STUCK_ALERT_RE = /^⚠️ (DELIVERY STUCK|CAPTAIN NOT DELIVERABLE)/;

/** Pure. Returns one decision per input entry, in input order. Never mutates
 *  the entries — annotated messages are returned on copies. */
export function coalesceBacklog(
  entries: MailboxEntry[],
  opts: { now: number; taskState: (taskId: string) => TaskState | undefined },
): BacklogDecision[] {
  // Kinds still queued AFTER each position, per task — walk backwards.
  const laterKinds = new Map<string, Set<string>>();
  const decisions: BacklogDecision[] = new Array(entries.length);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    decisions[i] = decide(entry, entry.taskId ? laterKinds.get(entry.taskId) : undefined, opts);
    if (entry.taskId) {
      let s = laterKinds.get(entry.taskId);
      if (!s) { s = new Set(); laterKinds.set(entry.taskId, s); }
      s.add(entry.kind);
    }
  }
  return decisions;
}

function decide(
  entry: MailboxEntry,
  later: Set<string> | undefined,
  opts: { now: number; taskState: (taskId: string) => TaskState | undefined },
): BacklogDecision {
  if (entry.kind === "captain.message") {
    if (entry.payload?.source !== "daemon" || !entry.message) return { action: "deliver", entry };
    if (STUCK_ALERT_RE.test(entry.message)) return { action: "skip", entry, reason: "moot-stuck-alert" };
    // #744: a daemon message that sat in the mailbox reads as stale, not current.
    const prefix = stalePrefix(Date.parse(entry.ts), opts.now);
    return { action: "deliver", entry: prefix ? { ...entry, message: `${prefix}${entry.message}` } : entry };
  }

  if (later) {
    if (TRANSIENT_KINDS.has(entry.kind)) return { action: "skip", entry, reason: "superseded" };
    if (entry.kind === "task.review" && (later.has("task.review") || Object.keys(TERMINAL_EVENT_STATE).some((k) => later.has(k)))) {
      return { action: "skip", entry, reason: "superseded" };
    }
  }

  const state = entry.taskId ? opts.taskState(entry.taskId) : undefined;
  const nowTerminal = state !== undefined && TERMINAL_STATES.has(state) && state !== TERMINAL_EVENT_STATE[entry.kind];
  if (nowTerminal && TRANSIENT_KINDS.has(entry.kind)) return { action: "skip", entry, reason: "task-terminal" };

  if (!entry.message) return { action: "deliver", entry };
  const stale = stalePrefix(Date.parse(entry.ts), opts.now) ?? "";
  const annotation = nowTerminal ? `[task now ${state}] ` : "";
  if (!stale && !annotation) return { action: "deliver", entry };
  return { action: "deliver", entry: { ...entry, message: `${stale}${annotation}${entry.message}` } };
}
