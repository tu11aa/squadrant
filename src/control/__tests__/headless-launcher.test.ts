// src/control/__tests__/headless-launcher.test.ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runHeadless } from "../headless-launcher.js";

function fakeChild() {
  const ee: any = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.pid = 7777;
  return ee;
}

describe("runHeadless", () => {
  it("emits task.started with pid, then task.done on exit 0", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const events: any[] = [];
    const p = runHeadless({
      provider: "claude", task: "x", id: "t1",
      spawn: spawn as any, emit: (e) => events.push(e),
    });
    expect(events[0]).toMatchObject({ type: "task.started", id: "t1", pid: 7777 });
    child.stdout.emit("data", '{"result":"ok","session_id":"s1"}');
    child.emit("close", 0);
    await p;
    const done = events.find((e) => e.type === "task.done");
    expect(done).toBeTruthy();
  });

  it("emits task.failed on non-zero exit", async () => {
    const child = fakeChild();
    const events: any[] = [];
    const p = runHeadless({
      provider: "claude", task: "x", id: "t2",
      spawn: (() => child) as any, emit: (e) => events.push(e),
    });
    child.stderr.emit("data", "explode");
    child.emit("close", 2);
    await p;
    expect(events.find((e) => e.type === "task.failed")).toMatchObject({ exitCode: 2 });
  });
});
