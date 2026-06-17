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
import type { ControlEvent } from "@cockpit/shared";

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
  /** taskId → the crew's opencode server port (for permission-reply POSTs). */
  private portByTask = new Map<string, number>();
  /** taskId → the last unresolved permission on the bus (for answer()). */
  private pendingPermByTask = new Map<string, { permID: string; sessionID: string }>();
  /** Synthetic monotonic request id. opencode has no numeric id on the bus, but
   *  task.approval.requested carries one (codex parity) to key gate promotion. */
  private nextRequestId = 1;
  private deps: OpencodeSseBridgeDeps;

  constructor(deps: OpencodeSseBridgeDeps) {
    this.deps = deps;
  }

  /** Begin subscribing to the crew's /event stream. Idempotent per task. */
  start(o: { taskId: string; port: number }): void {
    if (this.controllers.has(o.taskId)) return;
    this.portByTask.set(o.taskId, o.port);
    const ac = new AbortController();
    this.controllers.set(o.taskId, ac);
    void this.run(o.taskId, o.port, ac);
  }

  /** Stop subscribing for a task (crew closed / terminal). */
  stop(taskId: string): void {
    const ac = this.controllers.get(taskId);
    if (ac) { ac.abort(); this.controllers.delete(taskId); }
    this.portByTask.delete(taskId);
    this.pendingPermByTask.delete(taskId);
  }

  /**
   * Resolve a pending opencode permission by POSTing the captain's decision to
   * the crew's server (live-verified, opencode 1.15.13: POST
   * /session/{sessionID}/permissions/{permissionID} with
   * { response: "once" | "reject" } → 200, fires permission.replied). Mirrors
   * codex's driver.answer(). Returns true if there WAS a pending permission (so
   * the caller knows the answer was an approval, not a reply to a plain `signal
   * blocked` question); false if nothing was pending (already resolved on the
   * bus, or no gate).
   */
  async answer(taskId: string, decision: "approve" | "deny"): Promise<boolean> {
    const pend = this.pendingPermByTask.get(taskId);
    const port = this.portByTask.get(taskId);
    if (!pend || port == null) return false;
    this.pendingPermByTask.delete(taskId);
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const response = decision === "approve" ? "once" : "reject";
    try {
      await fetchImpl(`http://127.0.0.1:${port}/session/${pend.sessionID}/permissions/${pend.permID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response }),
      });
    } catch (e) {
      this.deps.log?.(`opencode permission reply failed for ${taskId}: ${(e as Error).message}`);
    }
    // Clear blocked → working; the crew continues (or aborts) the turn, and a
    // later session.idle settles it back to awaiting-input.
    this.deps.emit({ type: "task.started", id: taskId });
    return true;
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
    let json:
      | {
          type?: string;
          properties?: {
            id?: string;
            sessionID?: string;
            requestID?: string;
            permission?: string;
            patterns?: string[];
          };
        }
      | undefined;
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
    } else if (json?.type === "permission.asked") {
      // A gated tool (e.g. bash, when --approval set bash:"ask") needs approval.
      // Live-verified payload (opencode 1.15.13): properties = PermissionRequest
      // { id:"per_…", sessionID:"ses_…", permission:"bash", patterns:[cmd], … }.
      // Record the pending request so answer() can POST the decision, and surface
      // it as task.approval.requested (codex parity) — the reducer turns it into
      // blocked and the relay renders CREW BLOCKED with the tool + command.
      const p = json.properties;
      if (p?.id && p?.sessionID) {
        this.pendingPermByTask.set(taskId, { permID: p.id, sessionID: p.sessionID });
        const tool = p.permission ?? "a tool";
        const cmd = Array.isArray(p.patterns) && p.patterns.length ? `: ${p.patterns.join(" ")}` : "";
        this.deps.emit({
          type: "task.approval.requested",
          id: taskId,
          requestId: this.nextRequestId++,
          question: `opencode requests permission to run ${tool}${cmd}`,
          kind: tool,
        });
      }
    } else if (json?.type === "permission.replied") {
      // The permission was resolved on the bus (by us or another client) — clear
      // pending state so a later captain answer is a no-op rather than a stale POST.
      this.pendingPermByTask.delete(taskId);
    }
  }
}
