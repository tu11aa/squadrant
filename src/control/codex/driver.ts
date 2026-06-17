// src/control/codex/driver.ts
// Daemon-side interactive driver for codex. Owns ONE long-lived AppServerClient
// child, maps TaskRecord ↔ threadId, emits cockpit ControlEvents via the
// injected emit() hook. Notification mapping delegates to
// normalizeAppServerNotification (Task 2.3); the driver only routes server-
// requests and lifecycle. Spec §4.1/§4.6/§4.7.

import { AppServerClient } from "./app-server-client.js";
import { resolveCodexModel } from "./config.js";
import { normalizeAppServerNotification } from "./normalize.js";
import type { ControlEvent, TaskRecord } from "@cockpit/shared";
import { TERMINAL_STATES } from "@cockpit/shared";

/**
 * Boot-time guard for the daemon's codex reattach loop. Reattaching a thread
 * re-spawns its per-thread MCP servers (gitnexus/pay), so reattaching EVERY
 * non-terminal codex task on boot re-storms one MCP set per historical crew
 * (observed: 22 zombie tasks → 22 gitnexus servers → RAM exhaustion). Only
 * reattach a task that is (a) interactive codex, (b) non-terminal — closed
 * crews are `cancelled` via codex-close, so they're skipped, (c) still fresh:
 * a dead crew's pane is gone and hasn't heartbeat within the staleness window,
 * and (d) has a resumeRef to resume from.
 */
export function shouldReattachCodex(
  rec: TaskRecord,
  now: number,
  staleMs: number,
): boolean {
  if (rec.provider !== "codex" || rec.mode !== "interactive") return false;
  if (TERMINAL_STATES.has(rec.state)) return false;
  const last = rec.attempts.at(-1)?.lastHeartbeatAt ?? rec.lastHeartbeat ?? 0;
  if (now - last > staleMs) return false;
  return Boolean(rec.attempts.at(-1)?.resumeRef);
}

export interface DriverDeps {
  /** Override for tests; defaults to a real AppServerClient. */
  makeClient?: () => AppServerClient;
  /** Ingress into the daemon's event pipeline. */
  emit: (ev: ControlEvent) => void;
}

export class CodexInteractiveDriver {
  private client?: AppServerClient;
  private handshakeP?: Promise<void>;
  private threadByTask = new Map<string, string>();
  private taskByThread = new Map<string, string>();
  /**
   * taskId → in-flight dispatch promise. The first-turn say() can arrive while
   * dispatch() is still awaiting startThread (threadByTask not yet set); say()
   * awaits this gate before reading threadByTask so the first turn isn't lost
   * with "no thread for task" (issue #212).
   */
  private dispatchByTask = new Map<string, Promise<void>>();
  /** taskId → last pending server-request {id, method} (for answer()) */
  private serverRequestByTask = new Map<string, { id: number; method: string }>();
  private deps: DriverDeps;

  constructor(deps: DriverDeps) { this.deps = deps; }

  private async ensureClient(): Promise<AppServerClient> {
    if (this.client) return this.client;
    const c = (this.deps.makeClient ?? (() => new AppServerClient({ clientInfo: { name: "cockpit", version: "iv" } })))();
    this.client = c;
    c.start();
    c.on("notification", (n) => this.onNotification(n));
    c.on("serverRequest", (r) => this.onServerRequest(r));
    c.on("closed", () => { this.client = undefined; this.handshakeP = undefined; });
    return c;
  }

  private async ensureHandshake(): Promise<void> {
    const c = await this.ensureClient();
    if (!this.handshakeP) this.handshakeP = c.initialize().then(() => {});
    return this.handshakeP;
  }

  async dispatch(rec: TaskRecord & { cwd?: string; model?: string }): Promise<void> {
    // Register the in-flight dispatch synchronously so a concurrent first-turn
    // say() can await it (see dispatchByTask / issue #212). Cleared once the
    // thread is mapped (or dispatch failed), after which say() reads the map.
    const p = this.runDispatch(rec);
    this.dispatchByTask.set(rec.id, p.then(() => {}, () => {}));
    try {
      await p;
    } finally {
      this.dispatchByTask.delete(rec.id);
    }
  }

  private async runDispatch(rec: TaskRecord & { cwd?: string; model?: string }): Promise<void> {
    try {
      const c = await this.ensureClient();
      await withTimeout(this.ensureHandshake(), 10_000, "handshake timed out");
      // When no model is explicitly set on the task record, read the user's
      // codex config and apply model migrations (e.g. gpt-5.3-codex → gpt-5.5).
      // Without this the app-server falls back to the raw config value and
      // ChatGPT OAuth rejects it with a 400 (verified: gpt-5.5 succeeds).
      const model = rec.model ?? await resolveCodexModel();
      const { threadId } = await c.startThread({
        cwd: rec.cwd ?? process.cwd(),
        model,
        // Parity with claude/opencode crews, which run UNSANDBOXED (no Seatbelt).
        // Codex was the only agent under `workspace-write`, and that FS sandbox
        // blocked `cockpit crew signal …` from reaching the daemon socket (which
        // lives outside the workspace) — breaking the done/blocked/failed
        // lifecycle. Codex's AF_UNIX-socket allowance has no stable config path
        // (it's gated behind the experimental_network feature), so the surgical
        // writable_roots escape is not viable. danger-full-access removes the FS
        // jail so signals work; approvalPolicy still gates risky ops when set to
        // "untrusted" (the gate axis is independent of the sandbox axis).
        sandbox: "danger-full-access",
        approvalPolicy: rec.approvalPolicy ?? "never",
        developerInstructions: buildCodexDeveloperInstructions(rec),
      });
      this.threadByTask.set(rec.id, threadId);
      this.taskByThread.set(threadId, rec.id);
      this.deps.emit({ type: "task.session", id: rec.id, resumeRef: threadId });
      this.deps.emit({ type: "task.started", id: rec.id });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.emit({ type: "task.failed", id: rec.id, error: `handshake/start failed: ${msg}` });
      throw e;
    }
  }

  async say(taskId: string, text: string): Promise<void> {
    // Wait out any in-flight dispatch so the first turn isn't dropped during
    // the startThread window (#212). The gate never rejects; a failed dispatch
    // simply leaves threadByTask empty → the existing "no thread" throw stands.
    await this.dispatchByTask.get(taskId);
    const c = this.client!;
    const tid = this.threadByTask.get(taskId);
    if (!tid) throw new Error(`no thread for task ${taskId}`);
    await c.sendTurn(tid, text);
  }

  async steer(taskId: string, text: string): Promise<void> {
    const c = this.client!;
    const tid = this.threadByTask.get(taskId);
    if (!tid) throw new Error(`no thread for task ${taskId}`);
    await c.steerTurn(tid, text);
  }

  async interrupt(taskId: string): Promise<void> {
    const c = this.client!;
    const tid = this.threadByTask.get(taskId);
    if (!tid) throw new Error(`no thread for task ${taskId}`);
    await c.interruptTurn(tid);
  }

  /**
   * Tear down a task's thread when its crew closes. Cockpit runs ONE shared
   * app-server with a thread per crew; closing the cmux pane only kills the
   * `crew attach` renderer, so without this the thread — and the gitnexus/pay
   * MCP servers it spawned — leak forever (verified: ~53MB per orphaned crew).
   * Archiving the thread lets the app-server reap it and its MCP children.
   */
  async close(taskId: string): Promise<void> {
    const tid = this.threadByTask.get(taskId);
    this.serverRequestByTask.delete(taskId);
    if (!tid) return;
    this.threadByTask.delete(taskId);
    this.taskByThread.delete(tid);
    try {
      await this.client?.archiveThread(tid);
    } catch {
      // Best-effort: the app-server may already be gone. The maps are cleared
      // regardless so a daemon restart won't try to reattach a dead thread.
    }
  }

  async answer(taskId: string, payload: unknown): Promise<void> {
    const c = this.client!;
    const rec = this.serverRequestByTask.get(taskId);
    if (rec == null) throw new Error(`no pending server-request for task ${taskId}`);
    c.respondToServerRequest(rec.id, this.mapAnswerPayload(payload, rec.method));
    this.serverRequestByTask.delete(taskId);
  }

  /**
   * Map the captain-facing payload ({text, decision}) to the response shape
   * the codex app-server expects for the specific request method.
   *
   * Old protocol (applyPatchApproval / execCommandApproval):
   *   { decision: ReviewDecision }  where ReviewDecision = "approved" | "denied" | …
   *
   * v2 protocol (item/commandExecution/requestApproval / item/fileChange/requestApproval):
   *   { decision: CommandExecutionApprovalDecision }  where decision = "accept" | "decline" | …
   *
   * Non-approval requests (text input) pass through unchanged.
   */
  private mapAnswerPayload(payload: unknown, method: string): unknown {
    if (typeof payload !== "object" || !payload) return payload;
    const p = payload as Record<string, unknown>;
    if (typeof p.decision !== "string") return payload;
    if (method === "applyPatchApproval" || method === "execCommandApproval") {
      const d = p.decision === "approve" ? "approved" : "denied";
      return { decision: d };
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const d = p.decision === "approve" ? "accept" : "decline";
      return { decision: d };
    }
    // Unknown method — send the raw decision value
    return { decision: p.decision };
  }

  async reattach(rec: TaskRecord & { cwd?: string }): Promise<void> {
    await this.ensureHandshake();
    const c = this.client!;
    const resumeRef = rec.attempts.at(-1)?.resumeRef;
    if (!resumeRef) throw new Error(`reattach: no resumeRef on task ${rec.id}`);
    await c.resumeThread({ threadId: resumeRef, cwd: rec.cwd });
    this.threadByTask.set(rec.id, resumeRef);
    this.taskByThread.set(resumeRef, rec.id);
    this.deps.emit({ type: "task.reattached", id: rec.id });
  }

  private onNotification(n: { method: string; params?: any }): void {
    const tid = n.params?.threadId ?? n.params?.thread_id;
    const taskId = tid ? this.taskByThread.get(tid) : undefined;
    if (!taskId) return; // status-line only
    const ev = normalizeAppServerNotification(taskId, n);
    if (ev) this.deps.emit(ev);
  }

  private onServerRequest(r: { id: number; method: string; params?: any }): void {
    const tid = r.params?.threadId ?? r.params?.thread_id;
    let taskId = tid ? this.taskByThread.get(tid) : undefined;
    if (!taskId && !tid) {
      // Codex approval-shaped server-requests don't reliably carry threadId.
      // Fall back to the sole active task if exactly one exists; otherwise drop.
      if (this.taskByThread.size === 1) {
        taskId = this.taskByThread.values().next().value;
      } else {
        process.stderr.write(
          `[codex/driver] serverRequest ${r.method} dropped: no threadId and ${this.taskByThread.size} active tasks\n`,
        );
        return;
      }
    }
    if (!taskId) return;
    this.serverRequestByTask.set(taskId, { id: r.id, method: r.method });
    const isApproval = r.method.includes("Approval") || r.method.includes("approval");
    if (isApproval) {
      this.deps.emit({
        type: "task.approval.requested",
        id: taskId,
        requestId: r.id,
        question: String(r.params?.question ?? r.method),
        kind: r.method,
      });
    } else {
      this.deps.emit({
        type: "task.input.requested",
        id: taskId,
        requestId: r.id,
        question: String(r.params?.question ?? r.method),
      });
    }
  }
}

/**
 * Build the per-thread developerInstructions for a codex crew. Unlike
 * claude/opencode (which get COCKPIT_CREW_* env vars on their shell launch
 * line), codex tasks share ONE long-lived app-server child, so a process-level
 * env var would be wrong for concurrent tasks. Instead we tell each thread its
 * concrete task id + project and the exact flag-based signal command, so the
 * codex crew can report terminal state via `cockpit crew signal`. Appended
 * after the crew role body (when present) so the role still leads.
 */
export function buildCodexDeveloperInstructions(
  rec: { id: string; project: string; roleInstructions?: string },
): string {
  const directive =
    `You are cockpit crew task ${rec.id} in project ${rec.project}. ` +
    `When you finish, run EXACTLY: cockpit crew signal done --task-id ${rec.id} --project ${rec.project} --message "<one-line summary>". ` +
    `If you are blocked or fail, run cockpit crew signal blocked|failed with the same --task-id ${rec.id} --project ${rec.project} flags.`;
  return rec.roleInstructions ? `${rec.roleInstructions}\n\n${directive}` : directive;
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
