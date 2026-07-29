import { DeferDelivery, type DeferReason } from "./defer-delivery.js";

/**
 * #332: extracted defer-while-typing state machine (#258/#302).
 *
 * Behaviour ported from notify-relay.ts drain() (#332):
 *   - per-seq deferCounts / stableCounts / lastContent maps
 *   - maxDefers / stableProbePolls thresholds
 *   - stable-content probe escalation (#302)
 */
export interface CaptainDeliveryOptions {
  maxDefers: number;
  stableProbePolls: number;
}

export type SendFn = (text: string, opts?: { probe?: boolean }) => Promise<void>;

/** #617: the deferral classification surfaced for logging/alerting. Mostly the
 *  DeferReason sendToSurface already decided (see defer-delivery.ts), plus
 *  "stable" — CaptainDelivery's own byte-identical-across-polls signal (#302)
 *  that upgrades a "draft" into the more precise "content stopped changing,
 *  likely a paused human or a ghost, about to be probed" classification.
 *  "unknown" covers a non-DeferDelivery throw, which carries no classification. */
export type DeliverDeferReason = DeferReason | "stable" | "unknown";
export type DeliverResult = { delivered: true } | { deferred: true; reason: DeliverDeferReason };

/** Read-only deferral snapshot (B1 — dashboard visibility into #484/#466-class stalls). */
export interface CaptainDeliveryStats {
  /** Highest in-flight deferCount across all seqs currently being retried (0 when none). */
  maxDeferCount: number;
  /** true once maxDeferCount has reached the configured maxDefers threshold — the same
   *  point at which delivery force-escalates to a probe send. */
  stuck: boolean;
  /** Classification for the seq at maxDeferCount (#617). undefined when nothing is deferred. */
  reason?: DeliverDeferReason;
}

/**
 * Unified-formatter helper (#214/#210): the daemon's formatMessage is the single
 * source of truth for the captain-facing message. Returns null for entries the
 * daemon chose not to surface (null/empty message fields).
 */
export function deliverable(entry: { message?: string | null }): string | null {
  const msg = entry.message;
  if (msg == null) return null;
  const trimmed = msg.trim();
  return trimmed.length > 0 ? msg : null;
}

export class CaptainDelivery {
  private deferCounts = new Map<number, number>();
  private lastContent = new Map<number, string | null>();
  private stableCounts = new Map<number, number>();
  private lastReason = new Map<number, DeliverDeferReason>();

  constructor(private readonly opts: CaptainDeliveryOptions) {}

  /**
   * Attempt to deliver one mailbox entry to the captain. Calls `send(text, opts)`
   * and, if the send throws DeferDelivery, tracks defer/stable counts for the
   * entry's seq and returns {deferred: true} (caller should NOT advance cursor).
   * On success or null message returns {delivered: true} (caller SHOULD advance).
   */
  async deliver(
    entry: { seq: number; message?: string | null },
    send: SendFn,
  ): Promise<DeliverResult> {
    const msg = deliverable(entry);
    if (!msg) return { delivered: true };

    const seq = entry.seq;
    const deferCount = this.deferCounts.get(seq) ?? 0;
    // #302/#484: probe ONLY once content has been stable for stableProbePolls
    // polls (captain not typing / a ghost that isn't re-rendering). A probe
    // send makes sendToSurface inject a REAL backspace keystroke into the live
    // pane to run the structural liveness test (#258) — safe against a stable
    // box, but unsafe against one that's still actively changing: repeatedly
    // backspacing a genuinely-typing human's draft risks racing their next
    // keystroke and, per #484's reopened root-cause, eventually misclassifying
    // and force-delivering into it. deferCount alone must NEVER trigger a
    // probe — an actively-changing draft defers indefinitely until it goes
    // stable (paused) or empty (submitted); maxDefers stays meaningful only as
    // the `stuck` dashboard signal in stats() below, decoupled from escalation.
    const stable = (this.stableCounts.get(seq) ?? 0) >= this.opts.stableProbePolls;
    const probe = stable;

    try {
      await send(msg, probe ? { probe: true } : undefined);
      this.deferCounts.delete(seq);
      this.stableCounts.delete(seq);
      this.lastContent.delete(seq);
      this.lastReason.delete(seq);
      return { delivered: true };
    } catch (e) {
      if (e instanceof DeferDelivery) {
        this.deferCounts.set(seq, deferCount + 1);
        // Track content stability: byte-identical non-empty draft across
        // consecutive polls means the captain isn't actively typing (#302).
        const content = e.draft;
        let stableCount: number;
        if (content && content === this.lastContent.get(seq)) {
          stableCount = (this.stableCounts.get(seq) ?? 0) + 1;
          this.stableCounts.set(seq, stableCount);
        } else {
          stableCount = 0;
          this.stableCounts.set(seq, 0);
        }
        this.lastContent.set(seq, content);
        // #617: "stable" (byte-identical for stableProbePolls polls) is a more
        // precise classification than the raw "draft" reason once it applies —
        // it's the same signal that gates probe escalation just above, not a
        // new classifier. modal/no-box always win: they don't depend on content.
        const reason: DeliverDeferReason =
          e.reason !== "draft" ? e.reason
          : stableCount >= this.opts.stableProbePolls ? "stable"
          : "draft";
        this.lastReason.set(seq, reason);
        return { deferred: true, reason };
      }
      // Non-DeferDelivery errors: don't advance cursor, retry next poll.
      this.lastReason.set(seq, "unknown");
      return { deferred: true, reason: "unknown" };
    }
  }

  /** Read-only. Never mutates — safe to poll from the snapshot assembler every tick. */
  stats(): CaptainDeliveryStats {
    let maxDeferCount = 0;
    let reason: DeliverDeferReason | undefined;
    for (const [seq, c] of this.deferCounts) {
      if (c > maxDeferCount) {
        maxDeferCount = c;
        reason = this.lastReason.get(seq);
      }
    }
    return { maxDeferCount, stuck: maxDeferCount >= this.opts.maxDefers, reason };
  }
}
