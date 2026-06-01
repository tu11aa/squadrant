// src/control/opencode/sse-bridge.ts
// Daemon-side bridge from an opencode crew's HTTP event bus to cockpit
// ControlEvents. Interactive opencode crews launch as `opencode --port <N>`,
// which binds a local HTTP server exposing an SSE stream at GET /event. The TUI
// itself is just one client of that server; the daemon is another. We subscribe
// once per crew and translate the documented `session.idle` event (emitted when
// a turn finishes) into `task.turn.completed`, which the state-machine reduces
// to `awaiting-input`. This gives opencode the same reliable turn-end signal
// codex gets from its app-server — WITHOUT the crew shelling out to cockpit.
//
// `session.idle` is liveness, NOT completion (anti-#2576): a finished turn is
// not a finished task. Terminal state still comes from the explicit
// `cockpit crew signal done` in the crew template; the reducer absorbs any
// session.idle that arrives after the task is already terminal.
import type { ControlEvent } from "../types.js";

export interface OpencodeSseBridgeDeps {
  /** Ingress into the daemon's event pipeline (resolves project + handles). */
  emit: (ev: ControlEvent) => void;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable backoff for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Backoff between reconnect attempts (ms, default 500). */
  reconnectMs?: number;
  /** Attempts to reach the server before giving up the boot wait (default 60 ≈ 30s). */
  maxBootAttempts?: number;
  log?: (msg: string) => void;
}

/**
 * One long-lived SSE subscription per opencode crew. Keyed by taskId so the
 * daemon can stop it when the crew closes. Self-stops when the server's stream
 * ends (crew CLI exited) — at that point terminal state has already been
 * recorded via signal, or the watchdog/close path will reconcile.
 */
export class OpencodeSseBridge {
  private controllers = new Map<string, AbortController>();
  private deps: OpencodeSseBridgeDeps;

  constructor(deps: OpencodeSseBridgeDeps) {
    this.deps = deps;
  }

  /** Begin subscribing to the crew's /event stream. Idempotent per task. */
  start(o: { taskId: string; port: number }): void {
    if (this.controllers.has(o.taskId)) return;
    const ac = new AbortController();
    this.controllers.set(o.taskId, ac);
    void this.run(o.taskId, o.port, ac);
  }

  /** Stop subscribing for a task (crew closed / terminal). */
  stop(taskId: string): void {
    const ac = this.controllers.get(taskId);
    if (!ac) return;
    ac.abort();
    this.controllers.delete(taskId);
  }

  private async run(taskId: string, port: number, ac: AbortController): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const reconnectMs = this.deps.reconnectMs ?? 500;
    const maxBoot = this.deps.maxBootAttempts ?? 60;
    const url = `http://127.0.0.1:${port}/event`;
    let booted = false;
    let bootAttempts = 0;

    while (!ac.signal.aborted) {
      try {
        const res = await fetchImpl(url, {
          signal: ac.signal,
          headers: { accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
        booted = true;
        await this.consume(taskId, res.body, ac);
        // Stream ended cleanly: the opencode server closed (crew CLI exited).
        // Nothing more to subscribe to — stop without reconnecting.
        break;
      } catch (e) {
        if (ac.signal.aborted) return;
        if (!booted) {
          bootAttempts++;
          if (bootAttempts >= maxBoot) {
            this.deps.log?.(
              `opencode SSE bridge: gave up connecting to ${url} after ${bootAttempts} attempts: ${(e as Error).message}`,
            );
            this.controllers.delete(taskId);
            return;
          }
        }
        await sleep(reconnectMs);
      }
    }
    this.controllers.delete(taskId);
  }

  private async consume(
    taskId: string,
    body: ReadableStream<Uint8Array>,
    ac: AbortController,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (!ac.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          this.handleLine(taskId, line);
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
  }

  private handleLine(taskId: string, rawLine: string): void {
    let line = rawLine.trim();
    if (!line) return;
    // SSE field form `data: {json}`; opencode also emits bare JSON lines.
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (!line.startsWith("{")) return;
    let json: { type?: string; properties?: { sessionID?: string } } | undefined;
    try {
      json = JSON.parse(line);
    } catch {
      return; // partial/non-JSON keepalive line
    }
    if (json?.type === "session.idle") {
      // turnId is informational for opencode (no per-turn id on the bus); use
      // the session id so the ledger attempt carries a stable correlation key.
      this.deps.emit({
        type: "task.turn.completed",
        id: taskId,
        turnId: json.properties?.sessionID ?? "opencode",
      });
    }
  }
}
