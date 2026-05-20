// src/control/codex/app-server-client.ts
// Typed JSON-RPC 2.0 client for `codex app-server` v2.
// Transport: stdio (newline-delimited JSON). See spec §3.
// Defensive parser per orca codex-fetcher.ts:160-164: ignore non-JSON lines.

import { EventEmitter } from "node:events";
import { spawn as nodeSpawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

export interface AppServerClientOpts {
  /** Override for tests; defaults to spawning real `codex app-server`. */
  spawn?: () => Child;
  clientInfo?: { name: string; version: string };
}

export function _parseChunk(acc: { buf: string }, chunk: string): unknown[] {
  acc.buf += chunk;
  const out: unknown[] = [];
  let idx: number;
  while ((idx = acc.buf.indexOf("\n")) >= 0) {
    const line = acc.buf.slice(0, idx);
    acc.buf = acc.buf.slice(idx + 1);
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip non-JSON defensively */ }
  }
  return out;
}

export class AppServerClient extends EventEmitter {
  private proc?: Child;
  private acc = { buf: "" };
  private opts: AppServerClientOpts;
  constructor(opts: AppServerClientOpts = {}) { super(); this.opts = opts; }

  start(): void {
    if (this.proc) throw new Error("AppServerClient already started");
    const sp = this.opts.spawn ?? defaultSpawn;
    this.proc = sp();
    this.proc.stdout.on("data", (d: Buffer | string) => this._onStdout(d.toString()));
    this.proc.stderr.on("data", (d: Buffer | string) => this.emit("stderr", d.toString()));
    this.proc.on("exit", (code, signal) => this.emit("closed", { code, signal }));
    this.proc.on("error", (e) => this.emit("error", e));
  }

  kill(): void {
    if (this.proc) this.proc.kill();
  }

  async initialize(): Promise<unknown> {
    if (this._handshakeDone) return;
    if (!this.proc) throw new Error("AppServerClient not started");
    const info = this.opts.clientInfo ?? { name: "cockpit", version: "0" };
    // Send initialize directly (bypass gate) — only initialize may pre-handshake.
    const id = this.nextId++;
    const env = { jsonrpc: "2.0", id, method: "initialize", params: { clientInfo: info } };
    const res = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin.write(JSON.stringify(env) + "\n");
    });
    // Send 'initialized' as a notification (no id).
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    this._handshakeDone = true;
    return res;
  }

  startThread(params: { cwd: string; model?: string; sandbox?: string; approvalPolicy?: string }): Promise<{ threadId: string }> {
    return this._sendRequest("thread/start", params) as Promise<{ threadId: string }>;
  }

  resumeThread(params: { threadId: string; cwd?: string }): Promise<unknown> {
    return this._sendRequest("thread/resume", params);
  }

  readThread(params: { threadId: string; lastN?: number }): Promise<unknown> {
    return this._sendRequest("thread/read", params);
  }

  async sendTurn(threadId: string, text: string): Promise<{ turnId: string }> {
    const ack = await this._sendRequest("turn/start", {
      threadId, input: [{ type: "text", text }],
    }) as { turnId: string };
    return new Promise((resolve, reject) => {
      const onNote = (n: { method: string; params?: any }) => {
        if (n.params?.turnId !== ack.turnId) return;
        if (n.method === "turn/completed") { cleanup(); resolve(ack); }
        if (n.method === "turn/failed") { cleanup(); reject(new Error(n.params?.error ?? "turn failed")); }
      };
      const cleanup = () => this.off("notification", onNote);
      this.on("notification", onNote);
    });
  }

  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  protected _handshakeDone = false;

  protected _sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this._handshakeDone && method !== "initialize") {
      throw new Error(`AppServerClient: cannot call '${method}' before handshake (spec §3.2)`);
    }
    if (!this.proc) throw new Error("AppServerClient not started");
    const id = this.nextId++;
    const env = { jsonrpc: "2.0", id, method, params: params ?? {} };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin.write(JSON.stringify(env) + "\n");
    });
  }

  private _dispatchResponse(msg: any): boolean {
    if (typeof msg?.id !== "number") return false;
    const slot = this.pending.get(msg.id);
    if (!slot) return false;
    this.pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(`${msg.error.message ?? "rpc-error"} (code ${msg.error.code})`));
    else slot.resolve(msg.result);
    return true;
  }

  private _onStdout(s: string): void {
    for (const msg of _parseChunk(this.acc, s)) this._dispatch(msg);
  }

  private _dispatch(msg: unknown): void {
    if (this._dispatchResponse(msg)) return;
    if (typeof (msg as any)?.method === "string" && (msg as any).id === undefined) {
      this.emit("notification", { method: (msg as any).method, params: (msg as any).params });
      return;
    }
    // Server requests (have method AND id) handled in Task 1.10.
  }
}

function defaultSpawn(): Child {
  return nodeSpawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] }) as Child;
}
