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
});
