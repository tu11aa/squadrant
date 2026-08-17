// packages/agents/src/claude/peer-channel.ts
//
// #667 slice 3: ControlChannel over claude's UDS session inbox.
//
// The hard part is NOT sending — it is knowing what happened. Claude's accept
// path is silent (verified: no receipt after 20 s for a message that demonstrably
// arrived). So this composes three signals:
//
//   1. the wire result      -> did a process accept our bytes?
//   2. a receipt, if any    -> held/denied/delivered/expired (authoritative)
//   3. the T1 status flip   -> idle -> busy means a turn actually started
//
// Precedence: a receipt beats everything. Then a flip means confirmed. Then
// "accepted but unconfirmed", recorded honestly rather than guessed.
//
// RETRY: never here. accepted/queued/held are never retried (30 s byte-identical
// dedup would silently swallow it and manufacture a false negative). A transport
// failure surfaces as `gone` so the caller falls back to the pane exactly once.

import type { ControlChannel, DeliveryOutcome, ProbeResult, ChannelName } from "@squadrant/core";
import { buildUserEnvelope, type WireResult } from "./peer-wire.js";
import type { PeerReceipt } from "./receipt-listener.js";

/** Claude's registry `status` values (slice 1's registry.ts maps these). */
export type ClaudeStatus = "idle" | "busy" | "shell" | "waiting" | undefined;

export interface ClaudePeerChannelDeps {
  /** Where this task's session listens. undefined ⇒ this crew was not launched with the flag. */
  socketPathFor: (taskId: string) => string | undefined;
  /** Receiver's own session id — the pid-reuse guard. */
  sessionIdFor: (taskId: string) => string | undefined;
  /** Current registry status, from slice 1's ClaudePeerRegistrySource view. */
  statusFor: (taskId: string) => ClaudeStatus;
  wire: (socketPath: string, envelope: object) => Promise<WireResult>;
  receipts: { address: string; waitFor: (msgId: string, timeoutMs: number) => Promise<PeerReceipt | undefined> };
  newMsgId: () => string;
  sleep: (ms: number) => Promise<void>;
  /** How long to watch for a receipt and a status flip. */
  confirmWindowMs?: number;
  log?: (m: string) => void;
}

const DEFAULT_CONFIRM_WINDOW_MS = 4_000;

export class ClaudePeerChannel implements ControlChannel {
  readonly name: ChannelName = "claude-peer";
  readonly agent = "claude";

  constructor(private readonly deps: ClaudePeerChannelDeps) {}

  async send(taskId: string, message: string): Promise<DeliveryOutcome> {
    const socketPath = this.deps.socketPathFor(taskId);
    if (!socketPath) return { status: "unsupported" };

    const statusBefore = this.deps.statusFor(taskId);
    const msgId = this.deps.newMsgId();
    const envelope = buildUserEnvelope({
      content: message,
      msgId,
      from: this.deps.receipts.address,
      ...(this.deps.sessionIdFor(taskId) ? { sessionId: this.deps.sessionIdFor(taskId) } : {}),
    });

    const window = this.deps.confirmWindowMs ?? DEFAULT_CONFIRM_WINDOW_MS;
    // Arm the receipt wait BEFORE writing, or a fast hold receipt races past us.
    const receiptP = this.deps.receipts.waitFor(msgId, window);

    const w = await this.deps.wire(socketPath, envelope);
    if (!w.ok) {
      // Both "gone" and "transport" surface as gone: the caller falls back to the
      // pane once. Retrying here is what the 30 s dedup punishes.
      this.deps.log?.(`claude-peer: write failed (${w.reason}): ${w.error}`);
      return { status: "gone" };
    }

    const receipt = await receiptP;
    if (receipt) {
      if (receipt.status === "held") {
        return { status: "held", via: this.name, reason: receipt.reason };
      }
      if (receipt.status === "denied" || receipt.status === "expired") {
        // The user refused it or it aged out. It did NOT reach the session, but
        // re-sending would re-prompt a human who already said no. `gone` is the
        // honest branch: the caller logs and falls back exactly once.
        this.deps.log?.(`claude-peer: ${receipt.status} — ${receipt.reason}`);
        return { status: "gone" };
      }
      if (receipt.status === "delivered") {
        return { status: "accepted", via: this.name, confirmed: true };
      }
    }

    // No receipt: the silent-accept path. Use T1 to confirm T0. A flip out of
    // idle means our line started a turn. Anything else is unconfirmed — and we
    // say so instead of pretending.
    if (statusBefore === "idle") {
      await this.deps.sleep(window);
      const after = this.deps.statusFor(taskId);
      if (after === "busy" || after === "shell") {
        return { status: "accepted", via: this.name, confirmed: true };
      }
    }
    return { status: "accepted", via: this.name, confirmed: false };
  }

  /** Non-mutating. Registry presence only — never writes a byte. */
  async probe(taskId: string): Promise<ProbeResult> {
    if (!this.deps.socketPathFor(taskId)) return { status: "unsupported" };
    return this.deps.statusFor(taskId) === undefined
      ? { status: "gone" }
      : { status: "reachable", via: this.name };
  }
}
