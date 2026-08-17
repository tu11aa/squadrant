// packages/agents/src/claude/peer-wire.ts
//
// Claude cross-session messaging wire format (#667 slice 3).
//
// Empirically determined 2026-08-08 and reconfirmed on 2.1.233 (2026-08-17);
// see the spec's smoke sections. Framing is one JSON object + one "\n". The
// receiver NEVER sends anything back on the inbound connection — a successful
// connect+write is the entire in-band signal. Receipts arrive out-of-band on
// OUR socket (receipt-listener.ts), which is why `from` matters.
//
// This module is deliberately pure: envelope shape and byte delivery only. No
// registry reads, no retry policy, no outcome mapping.

import type { Socket } from "node:net";

/** Receiver destroys the connection past this. Refuse locally instead. */
const MAX_LINE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 3_000;

export interface PeerUserEnvelope {
  msgV: 1;
  msg_id: string;
  type: "user";
  priority: "next";
  session_id?: string;
  from?: string;
  message: { role: "user"; content: string };
}

export interface PeerWireDeps {
  connect: (path: string) => Socket;
  timeoutMs?: number;
}

export type WireResult =
  | { ok: true }
  | { ok: false; reason: "gone" | "transport"; error: string };

/**
 * Build the verified `type: "user"` envelope.
 *
 * `session_id` is the pid-reuse guard: a mismatch against the receiver's own id
 * is silently dropped, which is exactly what we want — better a silent drop than
 * a message injected into whoever inherited the pid.
 *
 * NOTE: no `from-mode` attestation is ever emitted. Attesting "bypass" against a
 * `--permission-mode auto` receiver holds EVERY message (verified twice).
 */
export function buildUserEnvelope(opts: {
  sessionId?: string;
  from?: string;
  content: string;
  msgId: string;
}): PeerUserEnvelope {
  if (!opts.content) throw new Error("peer-wire: message content must be a non-empty string");
  return {
    msgV: 1,
    msg_id: opts.msgId,
    type: "user",
    priority: "next",
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
    ...(opts.from ? { from: opts.from } : {}),
    message: { role: "user", content: opts.content },
  };
}

/** Write one NDJSON line. Resolves once the bytes are flushed. */
export function writeLine(
  socketPath: string,
  envelope: object,
  deps: PeerWireDeps,
): Promise<WireResult> {
  const line = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    return Promise.resolve({
      ok: false,
      reason: "transport",
      error: `line exceeds the receiver's 1 MiB buffer cap (${Buffer.byteLength(line, "utf8")} bytes)`,
    });
  }

  return new Promise<WireResult>((resolve) => {
    let settled = false;
    const done = (r: WireResult) => { if (!settled) { settled = true; resolve(r); } };

    const sock = deps.connect(socketPath);
    const timer = setTimeout(() => {
      try { sock.destroy(); } catch { /* best-effort */ }
      done({ ok: false, reason: "transport", error: `timeout after ${deps.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` });
    }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    sock.on("connect", () => {
      sock.write(line, () => {
        clearTimeout(timer);
        try { sock.end(); } catch { /* best-effort */ }
        done({ ok: true });
      });
    });

    sock.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ENOENT/ECONNREFUSED: nothing is listening -> the session is gone. That is
      // a real answer, not a transport blip, and it is the caller's cue to fall
      // back to the pane. Everything else may be transient.
      const gone = e.code === "ENOENT" || e.code === "ECONNREFUSED";
      done({ ok: false, reason: gone ? "gone" : "transport", error: e.message });
    });
  });
}
