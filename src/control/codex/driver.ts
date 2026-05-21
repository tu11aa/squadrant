// src/control/codex/driver.ts
// Daemon-side interactive driver for codex. Owns ONE long-lived AppServerClient
// child, maps TaskRecord ↔ threadId, emits cockpit ControlEvents via the
// injected emit() hook. Notification mapping delegates to
// normalizeAppServerNotification (Task 2.3); the driver only routes server-
// requests and lifecycle. Spec §4.1/§4.6/§4.7.

import { AppServerClient } from "./app-server-client.js";
import { normalizeAppServerNotification } from "./normalize.js";
import type { ControlEvent, TaskRecord } from "../types.js";

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
  /** taskId → last pending server-request id (for answer()) */
  private serverRequestByTask = new Map<string, number>();
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
    try {
      const c = await this.ensureClient();
      await withTimeout(this.ensureHandshake(), 10_000, "handshake timed out");
      const { threadId } = await c.startThread({
        cwd: rec.cwd ?? process.cwd(),
        model: rec.model,
        sandbox: "workspace-write",
        ...(rec.approvalPolicy ? { approvalPolicy: rec.approvalPolicy } : {}),
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

  async answer(taskId: string, payload: unknown): Promise<void> {
    const c = this.client!;
    const reqId = this.serverRequestByTask.get(taskId);
    if (reqId == null) throw new Error(`no pending server-request for task ${taskId}`);
    c.respondToServerRequest(reqId, payload);
    this.serverRequestByTask.delete(taskId);
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
    this.serverRequestByTask.set(taskId, r.id);
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

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
