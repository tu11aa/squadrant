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
