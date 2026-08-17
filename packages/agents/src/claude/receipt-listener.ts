// packages/agents/src/claude/receipt-listener.ts
//
// #667 slice 3: squadrant's own inbox, so Claude will talk back to us.
//
// Verified 2026-08-08: the receiver refuses to send a receipt to a `from`
// address outside its own socket namespace — the reply path must sit in the SAME
// DIRECTORY as the receiver's socket and end in ".sock". So this binds a socket
// next to the crews' sockets and advertises it in every envelope's `from`.
//
// That directory is therefore a trust boundary; hardening its permissions is
// tracked in #675, NOT here.
//
// Receipt semantics (all four verified live on 2.1.233, 2026-08-17):
//   held      -> awaiting the recipient user's approval
//   denied    -> user declined; NO user turn is ever added
//   delivered -> a previously-held message was released
//   expired   -> the hold aged out
// The plain accept path sends NOTHING. Absence of a receipt is ambiguous: it
// means delivered OR refused OR silently dropped. Never treat it as failure.

import type { Server } from "node:net";

export interface PeerReceipt {
  status: "held" | "denied" | "delivered" | "expired";
  reason: string;
  origMsgId: string;
}

const KNOWN: ReadonlySet<string> = new Set(["held", "denied", "delivered", "expired"]);

export interface ClaudeReceiptListenerDeps {
  socketPath: string;
  createServer: (handler: (conn: import("node:net").Socket) => void) => Server;
  log?: (m: string) => void;
}

export class ClaudeReceiptListener {
  readonly address: string;
  private server?: Server;
  private readonly waiters = new Map<string, (r: PeerReceipt) => void>();
  private lateCb?: (r: PeerReceipt) => void;

  constructor(private readonly deps: ClaudeReceiptListenerDeps) {
    this.address = `uds:${deps.socketPath}`;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.deps.createServer((conn) => this.handle(conn));
      this.server.listen(this.deps.socketPath, () => resolve());
    });
  }

  stop(): void {
    try { this.server?.close(); } catch { /* best-effort */ }
    this.server = undefined;
    this.waiters.clear();
  }

  onLate(cb: (r: PeerReceipt) => void): void { this.lateCb = cb; }

  /**
   * Wait for the receipt correlating to one msg_id.
   *
   * Resolves `undefined` on timeout — and that is NOT an error. The accept path
   * is silent by design, so "no receipt" is the common, healthy case.
   */
  waitFor(origMsgId: string, timeoutMs: number): Promise<PeerReceipt | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(origMsgId); resolve(undefined); }, timeoutMs);
      this.waiters.set(origMsgId, (r) => { clearTimeout(timer); this.waiters.delete(origMsgId); resolve(r); });
    });
  }

  private handle(conn: import("node:net").Socket): void {
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.dispatch(line);
      }
    });
    conn.on("error", () => { /* a peer hanging up is not our problem */ });
  }

  private dispatch(line: string): void {
    if (!line.trim()) return;
    let f: Record<string, unknown>;
    try { f = JSON.parse(line) as Record<string, unknown>; }
    catch { this.deps.log?.(`claude-receipt: discarded non-JSON frame`); return; }
    if (f.action !== "peer_message_status") return;
    const status = String(f.status ?? "");
    if (!KNOWN.has(status)) { this.deps.log?.(`claude-receipt: unknown status ${status}`); return; }

    const r: PeerReceipt = {
      status: status as PeerReceipt["status"],
      reason: String(f.reason ?? ""),
      origMsgId: String(f.orig_msg_id ?? ""),
    };
    const waiter = this.waiters.get(r.origMsgId);
    if (waiter) { waiter(r); return; }
    // No waiter: the send call already returned. This is the human-approved-a-hold
    // path — minutes can pass. Surface it so the captain learns the real outcome.
    this.lateCb?.(r);
  }
}
