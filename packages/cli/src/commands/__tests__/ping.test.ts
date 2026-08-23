import { describe, it, expect, vi, beforeEach } from "vitest";

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
const resolveCaptainChannelMode = vi.hoisted(() => vi.fn().mockReturnValue("off"));
vi.mock("@squadrant/shared", async (importOriginal) => ({
  ...((await importOriginal()) as any),
  loadConfig,
  resolveCaptainChannelMode,
  DEFAULT_CONFIG_PATH: "/dummy/path/.config/squadrant/config.json",
}));

const appendCaptainMessage = vi.hoisted(() => vi.fn());
const deliverToCaptain = vi.hoisted(() => vi.fn().mockResolvedValue({ handled: false }));
vi.mock("@squadrant/core", async (importOriginal) => ({
  ...((await importOriginal()) as any),
  appendCaptainMessage,
  deliverToCaptain,
}));

const requireDaemon = vi.hoisted(() => vi.fn());
vi.mock("../../lib/require-daemon.js", () => ({
  requireDaemon,
}));

const buildCaptainChannel = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("../../lib/captain-channel-factory.js", () => ({
  buildCaptainChannel,
}));

import { runPing, formatPingResult } from "../ping.js";

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

describe("runPing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadConfig.mockReturnValue(makeConfig());
    requireDaemon.mockResolvedValue(undefined);
    resolveCaptainChannelMode.mockReturnValue("off");
    deliverToCaptain.mockResolvedValue({ handled: false });
  });

  it("rejects an unregistered project with a clear error", async () => {
    await expect(runPing("nope", "hello")).rejects.toThrow(/not found/i);
    expect(send).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
    expect(appendCaptainMessage).not.toHaveBeenCalled();
  });

  it("delivers the message via the mailbox (enqueue) when daemon is running", async () => {
    status.mockResolvedValue({ id: "ws-1", name: "⚓ A-captain", status: "running" });

    await runPing("projA", "hello from ping");

    expect(send).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
    expect(appendCaptainMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "projA",
        text: "hello from ping",
        source: "cli",
      })
    );
  });

  it("errors clearly when the target captain is not running (no auto-boot)", async () => {
    status.mockResolvedValue(null);

    await expect(runPing("projA", "hello")).rejects.toThrow(/not running/i);
    expect(send).not.toHaveBeenCalled();
    expect(appendCaptainMessage).not.toHaveBeenCalled();
  });

  it("enqueues nothing if the daemon is not running", async () => {
    requireDaemon.mockRejectedValue(new Error("daemon not running"));

    await expect(runPing("projA", "hello")).rejects.toThrow(/daemon not running/i);
    
    expect(send).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
    expect(appendCaptainMessage).not.toHaveBeenCalled();
  });

  it("khi captainChannel = off thì runPing vẫn đi đường mailbox y như cũ", async () => {
    status.mockResolvedValue({ id: "ws-1", name: "⚓ A-captain", status: "running" });
    resolveCaptainChannelMode.mockReturnValue("off");
    
    await runPing("projA", "hello from ping fallback");

    expect(deliverToCaptain).toHaveBeenCalledWith(
      "projA",
      "hello from ping fallback",
      expect.objectContaining({ mode: "off", channel: undefined })
    );

    expect(appendCaptainMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "projA",
        text: "hello from ping fallback",
        source: "cli",
      })
    );
  });
});

describe("formatPingResult (#667 slice 4)", () => {
  it("keeps the legacy line when the channel was not used", () => {
    expect(formatPingResult("demo", undefined)).toBe("✔ Pinged 'demo'");
  });

  it("reports a confirmed accept as delivered, not merely pinged", () => {
    expect(formatPingResult("demo", { status: "accepted", via: "claude-peer", confirmed: true }))
      .toBe("✔ Delivered to 'demo' (accepted via claude-peer)");
  });

  it("does not claim delivery for an unconfirmed accept", () => {
    expect(formatPingResult("demo", { status: "accepted", via: "claude-peer", confirmed: false }))
      .toBe("✔ Sent to 'demo' (accepted via claude-peer (unconfirmed — no turn observed))");
  });

  it("says held, and says a human must act", () => {
    expect(formatPingResult("demo", { status: "held", via: "claude-peer", reason: "parity" }))
      .toBe("⏸ Held for 'demo' — awaiting approval in that session: parity");
  });

  it("says gone — evidence the captain is dead, replacing a screen read", () => {
    expect(formatPingResult("demo", { status: "gone" }))
      .toBe("⚠ Captain for 'demo' is not reachable — fell back to its pane mailbox");
  });
});
