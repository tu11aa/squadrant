import { describe, it, expect } from "vitest";
import { _parseChunk } from "../app-server-client.js";
import { AppServerClient } from "../app-server-client.js";
import { EventEmitter } from "node:events";

describe("app-server-client._parseChunk", () => {
  it("parses one newline-terminated JSON object", () => {
    const acc = { buf: "" };
    expect(_parseChunk(acc, '{"a":1}\n')).toEqual([{ a: 1 }]);
    expect(acc.buf).toBe("");
  });
  it("accumulates partial lines across chunks", () => {
    const acc = { buf: "" };
    expect(_parseChunk(acc, '{"a":')).toEqual([]);
    expect(_parseChunk(acc, '1}\n')).toEqual([{ a: 1 }]);
  });
  it("skips non-JSON lines defensively", () => {
    const acc = { buf: "" };
    expect(_parseChunk(acc, 'noise\n{"ok":true}\nmore noise\n')).toEqual([{ ok: true }]);
  });
  it("returns multiple objects from one chunk", () => {
    const acc = { buf: "" };
    expect(_parseChunk(acc, '{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

function fakeChild() {
  const stdin = new EventEmitter() as any;
  stdin.write = (s: string) => { (stdin as any)._written = ((stdin as any)._written ?? "") + s; return true; };
  stdin.end = () => {};
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as any;
  proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr;
  proc.kill = (signal?: string) => { proc.emit("exit", 0, signal ?? null); };
  return proc;
}

describe("AppServerClient lifecycle", () => {
  it("spawns via injected spawner and emits 'closed' on child exit", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    const closed = new Promise<void>((res) => c.on("closed", () => res()));
    c.start();
    proc.emit("exit", 0, null);
    await closed;
  });
  it("kill() ends the child", () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    c.kill();
    // exit emitted synchronously by fake; emitter's 'closed' fires
  });
});

describe("AppServerClient.sendRequest (correlation by id)", () => {
  it("resolves with result when the response arrives", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    // Bypass handshake gate for this unit-level test:
    (c as any)._handshakeDone = true;
    const p = (c as any)._sendRequest("foo/bar", { x: 1 });
    // Read the written line, mirror back a response
    const written = (proc.stdin as any)._written as string;
    const req = JSON.parse(written.trim());
    expect(req.method).toBe("foo/bar");
    expect(req.params).toEqual({ x: 1 });
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\n");
    await expect(p).resolves.toEqual({ ok: true });
  });
  it("rejects with error when an error response arrives", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    (c as any)._handshakeDone = true;
    const p = (c as any)._sendRequest("foo/bar", {});
    const req = JSON.parse((proc.stdin as any)._written.trim());
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "boom" } }) + "\n");
    await expect(p).rejects.toThrow(/boom/);
  });
});

describe("AppServerClient notifications", () => {
  it("emits 'notification' with method+params for id-less messages", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    const got: any[] = [];
    c.on("notification", (n) => got.push(n));
    proc.stdout.emit("data",
      JSON.stringify({ jsonrpc: "2.0", method: "agentMessageDelta", params: { text: "hi" } }) + "\n");
    expect(got).toEqual([{ method: "agentMessageDelta", params: { text: "hi" } }]);
  });
});

describe("AppServerClient handshake", () => {
  it("refuses any method call before handshake", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    expect(() => (c as any)._sendRequest("turn/start", {})).toThrow(/before handshake/);
  });
  it("initialize sends a request, awaits response, then sends 'initialized' notification", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc, clientInfo: { name: "cockpit", version: "test" } });
    c.start();
    const p = c.initialize();
    const first = JSON.parse((proc.stdin as any)._written.trim().split("\n")[0]);
    expect(first.method).toBe("initialize");
    expect(first.params.clientInfo).toEqual({ name: "cockpit", version: "test" });
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: first.id, result: { capabilities: {} } }) + "\n");
    await p;
    const lines = (proc.stdin as any)._written.trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.method).toBe("initialized");
    expect(last.id).toBeUndefined();
  });
});

describe("AppServerClient thread lifecycle", () => {
  it("startThread → thread/start with cwd; returns threadId", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    (c as any)._handshakeDone = true;
    const p = c.startThread({ cwd: "/tmp/x" });
    const req = JSON.parse((proc.stdin as any)._written.trim().split("\n").pop()!);
    expect(req.method).toBe("thread/start");
    expect(req.params.cwd).toBe("/tmp/x");
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { thread: { id: "T1" } } }) + "\n");
    await expect(p).resolves.toEqual({ threadId: "T1" });
  });
  it("resumeThread → thread/resume with threadId", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    (c as any)._handshakeDone = true;
    const p = c.resumeThread({ threadId: "T1", cwd: "/tmp/x" });
    const req = JSON.parse((proc.stdin as any)._written.trim().split("\n").pop()!);
    expect(req.method).toBe("thread/resume");
    expect(req.params.threadId).toBe("T1");
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\n");
    await p;
  });
  it("readThread → thread/read with threadId", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    (c as any)._handshakeDone = true;
    const p = c.readThread({ threadId: "T1" });
    const req = JSON.parse((proc.stdin as any)._written.trim().split("\n").pop()!);
    expect(req.method).toBe("thread/read");
    expect(req.params.threadId).toBe("T1");
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { messages: [] } }) + "\n");
    await p;
  });
});

describe("AppServerClient.sendTurn", () => {
  it("resolves when TurnCompleted notification arrives for this turn", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    (c as any)._handshakeDone = true;
    const p = c.sendTurn("T1", "hello");
    const req = JSON.parse((proc.stdin as any)._written.trim().split("\n").pop()!);
    expect(req.method).toBe("turn/start");
    expect(req.params.threadId).toBe("T1");
    // Schedule notifications for next tick to allow listener to be registered
    Promise.resolve().then(() => {
      // ack
      proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { turn: { id: "TURN-1" } } }) + "\n");
    }).then(() => {
      // streaming
      proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", method: "agentMessageDelta", params: { turn: { id: "TURN-1" }, text: "h" } }) + "\n");
    }).then(() => {
      // done
      proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "T1", turn: { id: "TURN-1" } } }) + "\n");
    });
    await expect(p).resolves.toMatchObject({ turnId: "TURN-1" });
  });
});

describe("AppServerClient steer/interrupt/inject", () => {
  it("steerTurn → turn/steer with threadId+text", async () => {
    const proc = fakeChild(); const c = new AppServerClient({ spawn: () => proc });
    c.start(); (c as any)._handshakeDone = true;
    const p = c.steerTurn("T1", "actually do X");
    const req = JSON.parse((proc.stdin as any)._written.trim().split("\n").pop()!);
    expect(req.method).toBe("turn/steer");
    expect(req.params).toEqual({ threadId: "T1", input: [{ type: "text", text: "actually do X" }] });
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\n");
    await p;
  });
  it("interruptTurn → turn/interrupt", async () => {
    const proc = fakeChild(); const c = new AppServerClient({ spawn: () => proc });
    c.start(); (c as any)._handshakeDone = true;
    const p = c.interruptTurn("T1");
    const req = JSON.parse((proc.stdin as any)._written.trim().split("\n").pop()!);
    expect(req.method).toBe("turn/interrupt");
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\n");
    await p;
  });
  it("injectItems → thread/inject_items with threadId+items", async () => {
    const proc = fakeChild(); const c = new AppServerClient({ spawn: () => proc });
    c.start(); (c as any)._handshakeDone = true;
    const items = [{ type: "text", text: "injected" }];
    const p = c.injectItems("T1", items);
    const req = JSON.parse((proc.stdin as any)._written.trim().split("\n").pop()!);
    expect(req.method).toBe("thread/inject_items");
    expect(req.params).toEqual({ threadId: "T1", items });
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\n");
    await p;
  });
});

describe("AppServerClient server-request round-trip", () => {
  it("emits 'serverRequest' for messages with method AND id; responds via respondToServerRequest", async () => {
    const proc = fakeChild(); const c = new AppServerClient({ spawn: () => proc });
    c.start(); (c as any)._handshakeDone = true;
    const got: any[] = [];
    c.on("serverRequest", (r) => got.push(r));
    // Server initiates a tool-input request
    proc.stdout.emit("data",
      JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tool/request-user-input", params: { question: "ok?" } }) + "\n");
    expect(got).toEqual([{ id: 42, method: "tool/request-user-input", params: { question: "ok?" } }]);
    // Application answers
    c.respondToServerRequest(42, { answer: "yes" });
    const lastLine = (proc.stdin as any)._written.trim().split("\n").pop()!;
    expect(JSON.parse(lastLine)).toEqual({ jsonrpc: "2.0", id: 42, result: { answer: "yes" } });
  });
});

describe("AppServerClient lifecycle cleanup", () => {
  it("on child exit, pending _sendRequest promises reject with 'closed'", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    (c as any)._handshakeDone = true;
    const p = (c as any)._sendRequest("foo/bar", {});
    proc.emit("exit", 0, null);
    await expect(p).rejects.toThrow(/closed/);
  });
  it("on child exit, an in-flight sendTurn promise rejects with 'closed'", async () => {
    const proc = fakeChild();
    const c = new AppServerClient({ spawn: () => proc });
    c.start();
    (c as any)._handshakeDone = true;
    const p = c.sendTurn("T1", "hi");
    // Mirror back the ack so we're past the await; now we're waiting on the notification
    const req = JSON.parse((proc.stdin as any)._written.trim().split("\n").pop()!);
    proc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { turn: { id: "TURN-X" } } }) + "\n");
    // Yield so the await completes and the notification listener is attached
    await new Promise((res) => setImmediate(res));
    proc.emit("exit", 0, null);
    await expect(p).rejects.toThrow(/closed/);
  });
});
