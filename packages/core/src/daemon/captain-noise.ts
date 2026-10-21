// #1017: keep crew lifecycle noise out of the captain pane. Pure classification
// (what is actionable, what a turn-end says) plus a per-crew informational digest.
// The captain pane uses the same CrewTier model as Telegram; informational events
// (plain idle, stalled, quiet) are silent by default and digested under tier `all`.
import type { ControlEvent, CrewTier } from "@squadrant/shared";
import { tierIncludes } from "../telegram/tiers.js";

/**
 * Turn-end classifier (deterministic, no LLM). A crew's final message is
 * "addressed" to the captain — and so worth a captain turn — when the last
 * non-code-fence line ends with "?" (a direct question) OR the final paragraph
 * names the captain (e.g. "Captain: PR is ready", "…let me know, captain").
 * Everything else is a plain end of turn: silent, ledger only.
 */
export function classifyTurnEnd(text: string | undefined): "addressed" | "plain" {
  if (!text?.trim()) return "plain";
  let inFence = false;
  let lastLine = "";
  const paragraphs: string[][] = [[]];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (line === "") { if (paragraphs.at(-1)!.length) paragraphs.push([]); continue; }
    lastLine = line;
    paragraphs.at(-1)!.push(line);
  }
  if (lastLine.endsWith("?")) return "addressed";
  const lastParagraph = (paragraphs.at(-1)!.length ? paragraphs.at(-1)! : paragraphs.at(-2) ?? []).join(" ");
  return /\bcaptain\b/i.test(lastParagraph) ? "addressed" : "plain";
}

/** A turn-end whose text is addressed to the captain: delivered as actionable, word for word. */
export function isAddressedTurnEnd(ev: ControlEvent): boolean {
  return ev.type === "task.turn.completed" && classifyTurnEnd(ev.lastMessage) === "addressed";
}

/**
 * Informational = a push that needs no captain action: plain idle, the first
 * stall (the one-shot hard escalation is actionable), CREW QUIET. Notify-only
 * warnings (task.warn, undelivered first turn) are never informational.
 */
export function isInformational(ev: ControlEvent): boolean {
  switch (ev.type) {
    case "task.turn.completed": return !isAddressedTurnEnd(ev);
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
