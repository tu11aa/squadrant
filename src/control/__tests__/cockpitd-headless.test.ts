// src/control/__tests__/cockpitd-headless.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "../protocol.js";

describe("cockpitd headless wiring", () => {
  let stop: (() => void) | undefined; let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("dispatch headless → child spawned → exit drives state to done", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-h-"));
    const sock = join(dir, "c.sock");
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 4321;
    const spawn = vi.fn(() => child);
    const h = startCockpitd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0, spawn: spawn as any });
    stop = h.stop;
    const disp: any = await sendRequest(sock, { kind: "dispatch", record: {
      id: "h1", project: "p", provider: "claude", mode: "headless",
      state: "submitted", task: "go", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "dispatch", heartbeatBudgetMs: 10000,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }] } });
    expect(disp.state).toBe("submitted");
    child.stdout.emit("data", '{"result":"done","session_id":"s1"}');
    child.emit("close", 0);
    await new Promise((r) => setTimeout(r, 20));
    const st: any = await sendRequest(sock, { kind: "status", project: "p", id: "h1" });
    expect(st.state).toBe("done");
  });

  it("stop() kills in-flight headless children", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-h-"));
    const sock = join(dir, "c.sock");
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 5678;
    child.kill = vi.fn();
    const spawn = vi.fn(() => child);
    const h = startCockpitd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0, spawn: spawn as any });
    stop = h.stop;
    await sendRequest(sock, { kind: "dispatch", record: {
      id: "h2", project: "p", provider: "claude", mode: "headless",
      state: "submitted", task: "go", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "dispatch", heartbeatBudgetMs: 10000,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }] } });
    await new Promise((r) => setTimeout(r, 20));
    h.stop();
    stop = undefined;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
