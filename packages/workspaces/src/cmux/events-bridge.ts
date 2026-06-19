// src/control/cmux/events-bridge.ts
// Daemon-side bridge from cmux's native event stream to cockpit ControlEvents
// (audit item B1 — reduce fragile screen-scraping).
//
// Unlike the per-crew OpencodeSseBridge, `cmux events` is a SINGLE global stream
// for the whole cmux app: one newline-delimited JSON frame per cmux event,
// carrying every agent's hook events. So this bridge is ONE long-lived
// subscription owned by the daemon. Each `agent` frame is correlated back to a
// crew TaskRecord by cwd (each interactive crew runs in a unique worktree path)
// and classified into a run-state (deriveRunState):
//   - `agent.hook.Stop` — the "turn ended / crew idle" signal the pane reader
//     infers by scraping — → `task.turn.completed`.
//   - `agent.hook.PreToolUse` / `UserPromptSubmit` (a turn is live) →
//     `task.progress` (B4/A3): a real-activity signal that refreshes the crew's
//     liveness clock so the watchdog does not false-stall a crew mid long,
//     screen-quiet tool call (#292).
//
// ADDITIVE & SAFE: this runs ALONGSIDE the existing relay-proxy/pane-reader path,
// which stays as the fallback. Both emissions are liveness, NOT completion
// (anti-#2576): terminal state still comes from the explicit `cockpit crew signal
// done`. The state-machine reducer already absorbs duplicate/late
// task.turn.completed and task.progress (a blocked crew stays blocked), so
// feeding them from BOTH paths is harmless.
import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { resolveCmuxBin } from "@cockpit/shared";
import type { ControlEvent } from "@cockpit/shared";

/** Minimal subset of ChildProcess this bridge needs (injectable for tests). */
export interface CmuxEventsChild {
  stdout: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean | void;
  on(event: "exit", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
}

/** Per-surface agent run-state derived from the hook stream (B4/A3). */
export type RunState = "working" | "idle";

/**
 * Pure. Classify an `agent.hook.*` event name into the crew's run-state, or
 * null for hooks that carry no run-state signal.
 *
 *   PreToolUse / UserPromptSubmit → "working"  (a turn is live)
 *   Stop                          → "idle"     (turn ended)
 *   SubagentStop / anything else  → null       (subagent end ≠ turn end)
 *
 * `Stop` is the existing turn-end signal (→ task.turn.completed). The "working"
 * hooks are the B4/A3 addition: they let the daemon keep a crew's liveness clock
 * fresh while it is mid (possibly long, screen-quiet) tool call, so the watchdog
 * does not false-stall it (#292). Only `PreToolUse` is live-confirmed in cmux
 * 0.64.16; `UserPromptSubmit` is mapped opportunistically (harmless if absent).
 */
export function deriveRunState(eventName: string): RunState | null {
  switch (eventName) {
    case "agent.hook.PreToolUse":
    case "agent.hook.UserPromptSubmit":
      return "working";
    case "agent.hook.Stop":
      return "idle";
    default:
      return null;
  }
}

/** A correlated hook frame, passed to the caller's record resolver. */
export interface CmuxAgentHook {
  cwd?: string;
  /** The emitting agent kind (`payload._source`, e.g. "claude"). */
  source?: string;
  /** The agent session id (`payload.session_id`). */
  sessionId?: string;
}

export interface CmuxEventsBridgeDeps {
  /** Ingress into the daemon's event pipeline (resolves project + handles). */
  emit: (ev: ControlEvent) => void;
  /**
   * Map an agent hook frame to its owning crew record, or undefined if none.
   * The daemon supplies this from the store (non-terminal interactive records
   * matched by cwd). Keeping it injected keeps the bridge pure and testable.
   */
  resolve: (hook: CmuxAgentHook) => { id: string } | undefined;
  /** Durable resume cursor passed to `cmux events --cursor-file`. */
  cursorFile: string;
  /** Injectable spawn for tests; defaults to spawning the real cmux binary. */
  spawnImpl?: (bin: string, args: string[]) => CmuxEventsChild;
  /** Injectable cmux binary path; defaults to resolveCmuxBin(). */
  cmuxBin?: string;
  /** Injectable backoff for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Backoff between respawn attempts after the child exits (ms, default 1000). */
  reconnectMs?: number;
  log?: (msg: string) => void;
  /** Test-only: stop after the first child exits (don't respawn). */
  stopAfterFirstRun?: boolean;
}

/**
 * One long-lived `cmux events` subscription for the whole daemon. The CLI's
 * `--reconnect` resumes the socket in-process; `--cursor-file` makes resume
 * durable across daemon (and child) restarts. If the child process itself dies,
 * we respawn with backoff so the consumer self-heals.
 */
export class CmuxEventsBridge {
  private child: CmuxEventsChild | null = null;
  private stopped = false;
  private buf = "";
  private deps: CmuxEventsBridgeDeps;

  constructor(deps: CmuxEventsBridgeDeps) {
    this.deps = deps;
  }

  /** Begin the subscription. Idempotent. */
  start(): void {
    if (this.child || this.stopped) return;
    void this.run();
  }

  /** Stop the subscription and kill the child (daemon shutdown). */
  stop(): void {
    this.stopped = true;
    const c = this.child;
    this.child = null;
    if (c) {
      try { c.kill(); } catch { /* already gone */ }
    }
  }

  private async run(): Promise<void> {
    const spawnImpl =
      this.deps.spawnImpl ??
      ((bin, args) => nodeSpawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] }) as ChildProcess as unknown as CmuxEventsChild);
    const bin = this.deps.cmuxBin ?? resolveCmuxBin();
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const reconnectMs = this.deps.reconnectMs ?? 1000;
    const args = [
      "events",
      "--reconnect",
      "--cursor-file", this.deps.cursorFile,
      "--category", "agent",
      "--no-heartbeat",
    ];

    while (!this.stopped) {
      this.buf = "";
      let child: CmuxEventsChild;
      try {
        child = spawnImpl(bin, args);
      } catch (e) {
        this.deps.log?.(`cmux events spawn failed: ${(e as Error).message}`);
        if (this.deps.stopAfterFirstRun) return;
        await sleep(reconnectMs);
        continue;
      }
      this.child = child;
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        child.stdout?.on("data", (b: Buffer | string) => this.onData(b));
        child.stdout?.on("end", done);
        child.on("exit", done);
        child.on("error", (err) => {
          this.deps.log?.(`cmux events child error: ${err.message}`);
          done();
        });
      });
      this.child = null;
      if (this.stopped || this.deps.stopAfterFirstRun) break;
      // Child died (cmux app restart, binary error): resume from the cursor.
      await sleep(reconnectMs);
    }
  }

  private onData(chunk: Buffer | string): void {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.handleLine(line);
    }
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line || line[0] !== "{") return;
    let f:
      | {
          type?: string;
          category?: string;
          name?: string;
          source?: string;
          payload?: { _source?: string; session_id?: string; cwd?: string; phase?: string; tool_name?: string };
        }
      | undefined;
    try {
      f = JSON.parse(line);
    } catch {
      return; // partial/non-JSON keepalive or ack we don't parse
    }
    // Only agent hook events; ignore ack/heartbeat and other categories.
    if (f?.type !== "event" || f.category !== "agent") return;
    // Classify the hook into a run-state. `Stop` is the main-session turn-end;
    // PreToolUse/UserPromptSubmit mean a turn is live; SubagentStop and any
    // other hook carry no turn-level run-state and are ignored.
    const runState = f.name ? deriveRunState(f.name) : null;
    if (!runState) return;
    const p = f.payload ?? {};
    // Each hook fires a "received" then "completed" phase frame; act on the
    // settled one so we emit exactly once per hook.
    if (p.phase === "received") return;
    const rec = this.deps.resolve({
      cwd: p.cwd,
      source: p._source ?? f.source,
      sessionId: p.session_id,
    });
    if (!rec) return;
    if (runState === "idle") {
      // Turn-end / idle — the signal the pane reader infers by scraping.
      this.deps.emit({
        type: "task.turn.completed",
        id: rec.id,
        turnId: p.session_id ?? "cmux",
      });
      return;
    }
    // working: feed a real-activity signal into the liveness path. task.progress
    // refreshes lastHeartbeatAt (the clock evaluateStall keys off), so a crew
    // that is mid long tool-call but screen-quiet is NOT false-stalled (#292),
    // and a crew the scrape path wrongly idled resumes to 'working'. ADDITIVE:
    // the reducer absorbs this idempotently, and a blocked crew stays blocked.
    // #354: carry the tool name on PreToolUse so the reducer can open a
    // tool-in-flight window (pendingTool) — the discriminator the watchdog uses
    // to tell a hung tool call apart from a quiet thinking turn.
    this.deps.emit({ type: "task.progress", id: rec.id, note: f.name, tool: p.tool_name });
  }
}
