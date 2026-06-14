// src/control/__tests__/headless-launcher.test.ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runHeadless } from "../headless-launcher.js";

function fakeChild() {
  const ee: any = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.pid = 7777;
  ee.kill = vi.fn();
  return ee;
}

describe("runHeadless", () => {
  it("emits task.started with pid, then task.done on exit 0", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const events: any[] = [];
    const writeResult = vi.fn(() => "/tmp/result/t1.txt");
    const { result } = runHeadless({
      provider: "claude", task: "x", id: "t1",
      spawn: spawn as any, emit: (e) => events.push(e),
      writeResult,
    });
    expect(events[0]).toMatchObject({ type: "task.started", id: "t1", pid: 7777 });
    child.stdout.emit("data", '{"result":"ok","session_id":"s1"}');
    child.emit("close", 0);
    await result;
    const done = events.find((e) => e.type === "task.done");
    expect(done).toBeTruthy();
    expect(events.some((e) => e.type === "task.progress")).toBe(true);
    expect(writeResult).toHaveBeenCalledWith("t1", "ok");
    expect(done).toMatchObject({ resultRef: "/tmp/result/t1.txt" });
  });

  it("spawns the child in opts.cwd (so codex/claude work in the project, not /)", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const { result } = runHeadless({
      provider: "codex", task: "x", id: "t9", cwd: "/work/proj",
      spawn: spawn as any, emit: () => {},
    });
    child.emit("close", 0);
    await result;
    expect(spawn).toHaveBeenCalledWith(
      "codex", expect.any(Array),
      expect.objectContaining({ cwd: "/work/proj" }),
    );
  });

  it("cwd unset → spawn cwd is undefined (inherit, back-compat)", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const { result } = runHeadless({
      provider: "claude", task: "x", id: "t10",
      spawn: spawn as any, emit: () => {},
    });
    child.emit("close", 0);
    await result;
    expect((spawn.mock.calls[0] as unknown[])[2]).toMatchObject({ cwd: undefined });
  });

  it("emits task.failed on non-zero exit", async () => {
    const child = fakeChild();
    const events: any[] = [];
    const { result } = runHeadless({
      provider: "claude", task: "x", id: "t2",
      spawn: (() => child) as any, emit: (e) => events.push(e),
    });
    child.stderr.emit("data", "explode");
    child.emit("close", 2);
    await result;
    expect(events.find((e) => e.type === "task.failed")).toMatchObject({ exitCode: 2 });
  });

  it("emits task.failed and resolves when spawn emits error (ENOENT)", async () => {
    const child = fakeChild();
    const events: any[] = [];
    const { result } = runHeadless({ provider: "claude", task: "x", id: "t3",
      spawn: (() => child) as any, emit: (e) => events.push(e) });
    child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await result; // must not hang
    expect(events.find((e) => e.type === "task.failed")).toMatchObject({ id: "t3" });
    expect(events.find((e) => e.type === "task.failed")?.error).toMatch(/spawn error/);
  });

  it("returns kill() that sends SIGTERM to child", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const { result, kill } = runHeadless({
      provider: "claude", task: "x", id: "t-kill",
      spawn: spawn as any, emit: () => {},
    });
    kill();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", 0);
    await result;
  });

  it("coalesces task.progress: 100 rapid chunks emit far fewer than 100 progress events", async () => {
    const child = fakeChild();
    const events: any[] = [];
    const { result } = runHeadless({
      provider: "claude", task: "x", id: "t-coalesce",
      spawn: (() => child) as any, emit: (e) => events.push(e),
    });
    for (let i = 0; i < 100; i++) child.stdout.emit("data", "chunk");
    child.emit("close", 0);
    await result;
    const progressCount = events.filter(e => e.type === "task.progress").length;
    // Before fix: 100 progress events. After fix: ≤ ~5 via batch+final-flush.
    expect(progressCount).toBeLessThan(10);
    expect(progressCount).toBeGreaterThan(0);
  });

  it("always emits a final task.progress flush on close for any pending chunks", async () => {
    const child = fakeChild();
    const events: any[] = [];
    const { result } = runHeadless({
      provider: "claude", task: "x", id: "t-flush",
      spawn: (() => child) as any, emit: (e) => events.push(e),
    });
    // 3 chunks — under the batch threshold, so none should emit mid-stream
    // (after the first immediate one), but close must flush the remainder
    child.stdout.emit("data", "a");
    child.stdout.emit("data", "b");
    child.stdout.emit("data", "c");
    child.emit("close", 0);
    await result;
    // task.done must follow any progress flush
    const types = events.map(e => e.type);
    const lastProgressIdx = types.lastIndexOf("task.progress");
    const doneIdx = types.indexOf("task.done");
    expect(doneIdx).toBeGreaterThan(-1);
    expect(lastProgressIdx).toBeLessThan(doneIdx); // progress always before done
  });

  it("caps stdout buffer at 4 MB: oversized output is trimmed to the tail", async () => {
    const child = fakeChild();
    const writeResult = vi.fn((_id: string, _payload: string) => "/tmp/r.txt");
    const { result } = runHeadless({
      provider: "claude", task: "x", id: "t-cap",
      spawn: (() => child) as any, emit: () => {},
      writeResult,
    });
    const MB = 1024 * 1024;
    // 5 MB of non-JSON data; claude adapter falls back to raw payload on parse error
    child.stdout.emit("data", "a".repeat(5 * MB));
    child.emit("close", 0);
    await result;
    // payload passed to writeResult must be ≤ 4 MB cap
    const captured = writeResult.mock.calls[0]![1];
    expect(captured.length).toBeLessThanOrEqual(4 * MB);
    expect(captured.length).toBeGreaterThan(0);
  });

  it("caps stderr buffer at 4 MB: oversized stderr is trimmed before parse", async () => {
    const child = fakeChild();
    const events: any[] = [];
    const { result } = runHeadless({
      provider: "claude", task: "x", id: "t-errcap",
      spawn: (() => child) as any, emit: (e) => events.push(e),
    });
    const MB = 1024 * 1024;
    child.stderr.emit("data", "e".repeat(5 * MB));
    child.emit("close", 1); // non-zero exit → uses err as parseInput
    await result;
    const failed = events.find(e => e.type === "task.failed");
    expect(failed).toBeTruthy();
    // error field comes from adapter.parseResult(err, 1) → err.slice(-2000)
    // the important thing is the process didn't OOM building a 5 MB err string
    // (we can't directly observe the trimmed err, but the event must exist)
    expect(failed.exitCode).toBe(1);
  });
});
