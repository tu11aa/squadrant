// src/control/protocol.ts
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";

// Bump this on any change to the request/reply wire shape.
// v1 is the first versioned release. Clients treat an absent _v as compatible
// (pre-v1 rollout grace period); future bumps hard-fail on mismatch.
export const PROTOCOL_VERSION = 1;

export function encodeMsg(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

export function createDecoder() {
  let buf = "";
  return {
    push(chunk: string): unknown[] {
      buf += chunk;
      const out: unknown[] = [];
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          // Silently discard keepalive frames (#94) — never surface to any consumer.
          if (typeof parsed === "object" && parsed !== null && (parsed as any).type === "_keepalive") continue;
          out.push(parsed);
        } catch { /* skip malformed */ }
      }
      return out;
    },
  };
}

export type Handler = (msg: any) => Promise<unknown>;

/** NetConn is the raw socket for a single client connection. */
export type NetConn = Socket;

/** Injectable clock for startServer — lets tests drive keepalive timers without real timers. */
export interface ServerDeps {
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (id: ReturnType<typeof setInterval>) => void;
}

/**
 * Optional callbacks for long-lived attach connections (spec §4.5/§4.6).
 * When a connection sends {op:"attach",taskId} the socket is "claimed" by
 * the attach path and all subsequent frames on that socket are routed to
 * onAttachInbound rather than through the normal request/response handler.
 */
export interface ServerCallbacks {
  /** Normal request/response handler (required). */
  handler: Handler;
  /** Called once when a connection sends the {op:"attach",taskId} frame. */
  onAttach?: (conn: NetConn, frame: { op: "attach"; taskId: string }) => void;
  /** Called for every subsequent inbound frame on a claimed attach connection. */
  onAttachInbound?: (conn: NetConn, frame: AttachInbound) => void;
  /** Called when a claimed attach connection closes. */
  onAttachClose?: (conn: NetConn) => void;
}

/**
 * Red-team #2 (High): an unhandled server `error` (e.g. listen EADDRINUSE when
 * a second daemon races in) became an uncaughtException → process died →
 * launchd KeepAlive (no ThrottleInterval) tight-respawned = the crash-loop.
 * Default: log with timestamp and exit non-zero so launchd's ThrottleInterval
 * paces the restart instead of tight-looping. Tests inject a spy.
 */
export function defaultListenError(e: Error): void {
  process.stderr.write(`[cockpitd] ${new Date().toISOString()} server error: ${e.message}\n`);
  process.exit(1);
}

export function startServer(
  sockPath: string,
  handlerOrCallbacks: Handler | ServerCallbacks,
  onListenError: (e: Error) => void = defaultListenError,
  deps: ServerDeps = {},
): Server {
  // Back-compat: accept a plain function as well as a ServerCallbacks object.
  const callbacks: ServerCallbacks =
    typeof handlerOrCallbacks === "function"
      ? { handler: handlerOrCallbacks }
      : handlerOrCallbacks;
  const { handler, onAttach, onAttachInbound, onAttachClose } = callbacks;
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;

  if (existsSync(sockPath)) {
    try { unlinkSync(sockPath); } catch { /* stale socket */ }
  }
  const server = createServer((conn) => {
    const dec = createDecoder();
    conn.setEncoding("utf-8");
    let claimType: "none" | "attach" = "none";
    let keepaliveId: ReturnType<typeof setInterval> | undefined;

    conn.on("data", async (chunk: string) => {
      for (const msg of dec.push(chunk)) {
        // If already claimed by attach, route all frames to the inbound handler.
        if (claimType === "attach") {
          onAttachInbound?.(conn, msg as AttachInbound);
          continue;
        }
        // Check for attach-claim frame BEFORE falling through to req/res.
        if (
          onAttach &&
          msg != null &&
          typeof msg === "object" &&
          (msg as any).op === "attach" &&
          typeof (msg as any).taskId === "string"
        ) {
          claimType = "attach";
          onAttach(conn, msg as { op: "attach"; taskId: string });
          // Start keepalive heartbeat for held-open attach connections (#94).
          keepaliveId = setIntervalFn(() => {
            try { conn.write(encodeFrame({ type: "_keepalive" })); } catch { /* conn closed */ }
          }, 10_000);
          continue;
        }
        // Normal request/response path.
        try {
          const reply = await handler(msg);
          conn.write(encodeMsg({ ok: true, reply, _v: PROTOCOL_VERSION }));
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          conn.write(encodeMsg({ ok: false, error: errMsg, _v: PROTOCOL_VERSION }));
        }
      }
    });
    conn.on("error", () => { /* client vanished; ignore */ });
    conn.on("close", () => {
      if (keepaliveId !== undefined) clearIntervalFn(keepaliveId);
      if (claimType === "attach") onAttachClose?.(conn);
    });
  });
  server.on("error", onListenError); // never let a server error become uncaughtException
  server.listen(sockPath);
  return server;
}

export function sendRequest(sockPath: string, msg: unknown, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(sockPath);
    const dec = createDecoder();
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("control plane unavailable: request timed out"));
    }, timeoutMs);
    conn.setEncoding("utf-8");
    conn.on("connect", () => conn.write(encodeMsg({ ...(msg as Record<string, unknown>), _v: PROTOCOL_VERSION })));
    conn.on("data", (chunk: string) => {
      for (const m of dec.push(chunk) as any[]) {
        clearTimeout(timer);
        conn.destroy();
        if (m._v !== undefined && m._v !== PROTOCOL_VERSION) {
          reject(new Error(`cockpitd protocol v${m._v}, this client expects v${PROTOCOL_VERSION} — upgrade cockpitd or this CLI`));
        } else if (m.ok) {
          resolve(m.reply);
        } else {
          reject(new Error(m.error));
        }
        return;
      }
    });
    conn.on("error", () => {
      clearTimeout(timer);
      reject(new Error("control plane unavailable: cannot reach cockpitd socket"));
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Streaming-subscribe frames for `cockpit crew chat / attach` (spec §4.5).
// Additive; existing request/response verbs untouched. Cooperates with #87.

export type AttachFrame =
  | { type: "delta"; taskId: string; text: string }
  | { type: "turn-started"; taskId: string }
  | { type: "turn-completed"; taskId: string }
  | { type: "input-requested"; taskId: string; requestId: number; question: string }
  | { type: "approval-requested"; taskId: string; requestId: number; question: string; kind: string }
  | { type: "gate-promoted"; taskId: string; gateId: string }
  | { type: "reattached"; taskId: string }
  | { type: "closed"; taskId: string; reason: string }
  | { type: "_keepalive" };

export type AttachInbound =
  | { op: "attach"; taskId: string }
  | { op: "say"; taskId: string; text: string }
  | { op: "steer"; taskId: string; text: string }
  | { op: "interrupt"; taskId: string }
  | { op: "answer"; taskId: string; requestId: number; payload: unknown };

export function encodeFrame(f: AttachFrame): string {
  return JSON.stringify(f) + "\n";
}

export function decodeFrames(wire: string): AttachFrame[] {
  const out: AttachFrame[] = [];
  for (const line of wire.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AttachFrame;
      if (parsed.type === "_keepalive") continue; // discard keepalive frames (#94)
      out.push(parsed);
    } catch { /* skip malformed */ }
  }
  return out;
}
