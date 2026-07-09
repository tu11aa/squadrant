import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";

const status = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const sendKey = vi.hoisted(() => vi.fn());

vi.mock("@squadrant/workspaces", () => ({
  createCmuxDriver: () => ({
    name: "cmux",
    probe: vi.fn(),
    list: vi.fn(),
    status,
    spawn: vi.fn(),
    send,
    sendKey,
    readScreen: vi.fn(),
    stop: vi.fn(),
  }),
  RuntimeRegistry: class {
    constructor(private drivers: Record<string, unknown>) {}
    forProject() { return this.drivers.cmux; }
    global() { return this.drivers.cmux; }
    get(name: string) { return (this.drivers as Record<string, unknown>)[name]; }
  },
}));

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", () => ({
  loadConfig,
}));

const appendCaptainMessage = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/core", async (importOriginal) => ({
  ...((await importOriginal()) as any),
  appendCaptainMessage,
}));

const requireDaemon = vi.hoisted(() => vi.fn());
vi.mock("../../lib/require-daemon.js", () => ({
  requireDaemon,
}));

// Mock process.exit and console.error
vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
vi.spyOn(console, "error").mockImplementation(() => {});

import { runRuntimeSend } from "../runtime.js";

const makeConfig = () => ({
  commandName: "command",
  hubVault: "~/hub",
  projects: {
    projA: { path: "/projects/a", captainName: "⚓ A-captain", spokeVault: "/spokes/a", host: "local" },
  },
  defaults: {
    maxCrew: 5,
    worktreeDir: ".worktrees",
    teammateMode: "in-process",
    permissions: { command: "auto", captain: "auto", crew: "auto" },
  },
  metrics: { enabled: false, path: "/tmp/metrics.json" },
});

describe("runtime send", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadConfig.mockReturnValue(makeConfig());
    requireDaemon.mockResolvedValue(undefined);
    status.mockResolvedValue({ id: "ws-1", name: "⚓ A-captain", status: "running" });
  });

  it("delivers the message via the mailbox (enqueue) when daemon is running", async () => {
    await runRuntimeSend("projA", "hello from runtime send", {});

    expect(send).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
    expect(appendCaptainMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "projA",
        text: "hello from runtime send",
        source: "cli",
      })
    );
  });

  it("enqueues under cfg.commandName when using --command", async () => {
    await runRuntimeSend("hello from command", undefined, { command: true });

    expect(send).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
    expect(appendCaptainMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "command",
        text: "hello from command",
        source: "cli",
      })
    );
  });

  it("enqueues nothing if the daemon is not running", async () => {
    requireDaemon.mockRejectedValue(new Error("daemon not running"));

    await expect(runRuntimeSend("projA", "hello from runtime send", {})).rejects.toThrow(/daemon not running/i);
    
    expect(send).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
    expect(appendCaptainMessage).not.toHaveBeenCalled();
  });
});
