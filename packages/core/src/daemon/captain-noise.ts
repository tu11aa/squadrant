// #1017: keep crew lifecycle noise out of the captain pane. Pure classification
// (what is actionable, what a turn-end says) plus a per-crew informational digest.
// The captain pane uses the same CrewTier model as Telegram; informational events
// (plain idle, stalled, quiet) are silent by default and digested under tier `all`.
import type { ControlEvent, CrewTier } from "@squadrant/shared";
import { tierIncludes } from "../telegram/tiers.js";

/**
 * Turn-end text classifier (deterministic, language-neutral, no LLM): the text is
 * "addressed" when its last non-code-fence line ends with "?" (a direct question).
 * Anything else is "plain". Whether a turn-end is a *reply to the captain* is not
 * a text question at all — the daemon stamps `reply` on the first turn-end after a
 * captain message (see reduce.ts), so no keyword in any language is needed.
 */
export function classifyTurnEnd(text: string | undefined): "addressed" | "plain" {
  if (!text?.trim()) return "plain";
  let inFence = false;
  let lastLine = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence || line === "") continue;
    lastLine = line;
  }
  return lastLine.endsWith("?") ? "addressed" : "plain";
}

/** A turn-end WITH text that is a reply to the captain or ends in a question: delivered word for word. */
export function isAddressedTurnEnd(ev: ControlEvent): boolean {
  return ev.type === "task.turn.completed" && !!ev.lastMessage?.trim() && (ev.reply === true || classifyTurnEnd(ev.lastMessage) === "addressed");
}

/**
 * Informational = a push that needs no captain action: plain idle (text, no reply), the first
 * stall (the one-shot hard escalation is actionable), CREW QUIET. Notify-only
 * warnings (task.warn, undelivered first turn) are never informational.
 */
export function isInformational(ev: ControlEvent): boolean {
  switch (ev.type) {
    // Only a turn-end WITH text can be classified plain. No text (Codex/OpenCode, or an
    // unresolvable Claude message) keeps today's generic CREW IDLE behaviour.
    case "task.turn.completed": return !!ev.lastMessage?.trim() && !isAddressedTurnEnd(ev);
    case "task.stalled": return !ev.escalated;
    case "task.quiet":
    case "task.idle": return true;
    default: return false;
  }
}

/**
 * Does the captain pane take a captain turn for this event at this tier?
 * `alert_only` (default) delivers everything that is not informational — including
 * notify-only warnings, reminders and API-error turn-ends. `done_only` is the strict
 * Telegram set (done/failed).
 */
export function captainPaneAllows(tier: CrewTier, ev: ControlEvent): boolean {
  if (tier === "none") return false;
  if (tier === "all") return true;
  if (isInformational(ev)) return false;
  return tier === "alert_only" ? true : tierIncludes(tier, ev.type);
}

const LABEL: Record<string, string> = {
  "task.turn.completed": "idle",
  "task.idle": "idle",
  "task.stalled": "stalled",
  "task.quiet": "quiet",
};

/**
 * Per-crew coalescing of informational events: each push (re)arms a quiet-window
 * timer, and when it fires the crew's events leave as ONE digest line. `flush`
 * releases early (before an actionable event for the same crew, keeping order).
 * Delivery into the captain pane still goes through the normal mailbox/delivery
 * loop, which already defers while the captain is mid-turn.
 */
export class InformationalDigest {
  private readonly pending = new Map<string, { tag: string; counts: Map<string, number>; last: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly emit: (key: string, message: string) => void,
    private readonly windowMs: number,
  ) {}

  push(key: string, tag: string, ev: ControlEvent, message: string): void {
    const cur = this.pending.get(key);
    if (cur) clearTimeout(cur.timer);
    const counts = cur?.counts ?? new Map<string, number>();
    const label = LABEL[ev.type] ?? ev.type;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    const timer = setTimeout(() => this.flush(key), this.windowMs);
    timer.unref?.();
    this.pending.set(key, { tag, counts, last: message, timer });
  }

  flush(key: string): void {
    const cur = this.pending.get(key);
    if (!cur) return;
    clearTimeout(cur.timer);
    this.pending.delete(key);
    const summary = [...cur.counts].map(([k, n]) => `${n} ${k}`).join(", ");
    this.emit(key, `CREW DIGEST ${cur.tag}: ${summary} (informational, no action needed) — latest: ${cur.last}`);
  }
}
