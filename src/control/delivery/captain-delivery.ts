import { DeferDelivery } from "../../runtimes/cmux";

/**
 * #332: extracted defer-while-typing state machine (#258/#302).
 *
 * Behaviour is ported VERBATIM from notify-relay.ts drain() (lines 276-309):
 *   - per-seq deferCounts / stableCounts / lastContent maps
 *   - maxDefers / stableProbePolls thresholds
 *   - stable-content probe escalation (#302)
 *
 * Both the relay (flag OFF) and the daemon (flag ON) consume this same module
 * so flag-OFF parity is guaranteed.
 */
export interface CaptainDeliveryOptions {
  maxDefers: number;
  stableProbePolls: number;
}

export type SendFn = (text: string, opts?: { probe?: boolean }) => Promise<void>;
export type DeliverResult = { delivered: true } | { deferred: true };

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
    // #302: probe early once content has been stable for stableProbePolls
    // polls (captain not typing) — kills the ~5min stall; the 300-defer
    // backstop still guarantees delivery never hangs forever.
    const stable = (this.stableCounts.get(seq) ?? 0) >= this.opts.stableProbePolls;
    const probe = stable || deferCount >= this.opts.maxDefers;

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
}
