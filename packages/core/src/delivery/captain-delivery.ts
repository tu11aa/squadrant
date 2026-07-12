import { DeferDelivery } from "./defer-delivery.js";

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
export type DeliverResult = { delivered: true } | { deferred: true };

/** Read-only deferral snapshot (B1 — dashboard visibility into #484/#466-class stalls). */
export interface CaptainDeliveryStats {
  /** Highest in-flight deferCount across all seqs currently being retried (0 when none). */
  maxDeferCount: number;
  /** true once maxDeferCount has reached the configured maxDefers threshold — the same
   *  point at which delivery force-escalates to a probe send. */
  stuck: boolean;
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
      return { delivered: true };
    } catch (e) {
      if (e instanceof DeferDelivery) {
        this.deferCounts.set(seq, deferCount + 1);
        // Track content stability: byte-identical non-empty draft across
        // consecutive polls means the captain isn't actively typing (#302).
        const content = e.draft;
        if (content && content === this.lastContent.get(seq)) {
          this.stableCounts.set(seq, (this.stableCounts.get(seq) ?? 0) + 1);
        } else {
          this.stableCounts.set(seq, 0);
        }
        this.lastContent.set(seq, content);
        return { deferred: true };
      }
      // Non-DeferDelivery errors: don't advance cursor, retry next poll.
      return { deferred: true };
    }
  }

  /** Read-only. Never mutates — safe to poll from the snapshot assembler every tick. */
  stats(): CaptainDeliveryStats {
    let maxDeferCount = 0;
    for (const c of this.deferCounts.values()) if (c > maxDeferCount) maxDeferCount = c;
    return { maxDeferCount, stuck: maxDeferCount >= this.opts.maxDefers };
  }
}
