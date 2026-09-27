// #828 P6-C phase 2: `squadrant gate opencode-run` is the command a gate-wrapped
// opencode crew/captain pane runs instead of bare `opencode`. These tests pin
// its two documented behaviours: buildRunPlan gets the port squadrant already
// allocated (via `allocate`), and any failure anywhere in the auto-gate
// pipeline falls back to launching opencode directly — a gate defect must
// never stop a crew from starting.

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runGateOpencodeRun } from "../gate-opencode-run.js";
import type { RunPlan } from "@squadrant-ai/auto-gate";

function fakeChild() {
  const emitter = new EventEmitter() as EventEmitter & {
    on(event: "exit", cb: (code: number | null) => void): EventEmitter;
    on(event: "error", cb: (err: Error) => void): EventEmitter;
  };
  return emitter;
}

describe("runGateOpencodeRun (#828 P6-C phase 2)", () => {
  it("calls buildRunPlan with allocate resolving to squadrant's own port, then supervises the plan", async () => {
    const plan: RunPlan = { opencodeArgs: ["--port", "4096"], env: { AUTO_GATE_OPENCODE_PORT: "4096" }, watcherArgs: ["opencode", "watch", "--port", "4096"] };
    const buildRunPlan = vi.fn(async (i: { args: string[]; allocate: () => Promise<number> }) => {
      const port = await i.allocate();
      expect(port).toBe(4096);
      return plan;
    });
    const supervise = vi.fn(async (p: RunPlan) => {
      expect(p).toBe(plan);
      return 0;
    });

    const code = await runGateOpencodeRun(
      { port: 4096, args: ["--session", "ses_abc"] },
      { buildRunPlan, supervise },
    );

    expect(code).toBe(0);
    expect(buildRunPlan).toHaveBeenCalledOnce();
    expect(buildRunPlan.mock.calls[0][0].args).toEqual(["--session", "ses_abc"]);
    expect(supervise).toHaveBeenCalledOnce();
  });

  it("falls back to a direct opencode launch when buildRunPlan throws, and logs one warning", async () => {
    const buildRunPlan = vi.fn(async () => {
      throw new Error("args already specifies --port");
    });
    const supervise = vi.fn();
    const child = fakeChild();
    const spawnDirect = vi.fn((cmd: string, args: string[]) => {
      expect(cmd).toBe("opencode");
      expect(args).toEqual(["--session", "ses_abc", "--port", "4096"]);
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    const log = vi.fn();

    const code = await runGateOpencodeRun(
      { port: 4096, args: ["--session", "ses_abc"] },
      { buildRunPlan, supervise, spawnDirect, log },
    );

    expect(code).toBe(0);
    expect(supervise).not.toHaveBeenCalled();
    expect(spawnDirect).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("launching opencode directly");
  });

  it("falls back to a direct opencode launch when supervise throws", async () => {
    const plan: RunPlan = { opencodeArgs: [], env: {}, watcherArgs: [] };
    const buildRunPlan = vi.fn(async () => plan);
    const supervise = vi.fn(async () => {
      throw new Error("watcher spawn ENOENT");
    });
    const child = fakeChild();
    const spawnDirect = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    });
    const log = vi.fn();

    const code = await runGateOpencodeRun({ port: 4096, args: [] }, { buildRunPlan, supervise, spawnDirect, log });

    expect(code).toBe(1);
    expect(spawnDirect).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
