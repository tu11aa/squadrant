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
  DEFAULT_CONFIG_PATH: "/dummy/path/.config/squadrant/config.json",
}));

const appendCaptainMessage = vi.hoisted(() => vi.fn());
const waitForCaptainDelivery = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/core", async (importOriginal) => ({
  ...((await importOriginal()) as any),
  appendCaptainMessage,
  waitForCaptainDelivery,
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
    appendCaptainMessage.mockResolvedValue(42);
    waitForCaptainDelivery.mockResolvedValue(true);
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

  // #566 bug (b): v0.16 routed runtime send through the mailbox (#529) so a
  // draft in progress is never clobbered, but that made success gated on the
  // async delivery loop while the CLI reported success the instant the append
  // landed — regardless of whether a captain was ever there to receive it.
  it("waits for the delivery cursor to confirm the message actually reached the pane", async () => {
    await runRuntimeSend("projA", "hello from runtime send", {});

    expect(waitForCaptainDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ project: "projA", seq: 42 }),
    );
  });

  // The core regression: a captain falsely reported "stopped"/unreachable (#565)
  // must not turn into a silent success. If delivery is never confirmed, the
  // command must fail loudly (reject) rather than resolve.
  it("fails loudly when delivery is never confirmed (captain unreachable/falsely-stopped, #565-class)", async () => {
    waitForCaptainDelivery.mockResolvedValue(false);

    await expect(runRuntimeSend("projA", "hello from runtime send", {})).rejects.toThrow(/not confirmed|not delivered/i);

    // The send attempt itself must still have been made — never pre-gated on
    // a liveness verdict — only the *confirmation* is what fails here.
    expect(appendCaptainMessage).toHaveBeenCalled();
  });
});
