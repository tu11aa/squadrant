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
const buildCaptainChannels = vi.hoisted(() => vi.fn().mockResolvedValue({ channels: {}, agentFor: () => undefined }));
vi.mock("../../lib/captain-channel-factory.js", () => ({
  buildCaptainChannel,
  buildCaptainChannels,
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

  it("#1029: --from names the sender in the channel text, and the mailbox fallback stores bare text + from", async () => {
    status.mockResolvedValue({ id: "ws-1", name: "⚓ A-captain", status: "running" });
    await runPing("projA", "found it", "side:side-1");
    expect(deliverToCaptain.mock.calls[0][1]).toBe("📨 side:side-1\nfound it");
    expect(appendCaptainMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "found it", source: "cli", from: "side:side-1" }),
    );
  });

  it("#1029 r2: run inside another registered project, the sender is captain:<that project> with a reply hint", async () => {
    status.mockResolvedValue({ id: "ws-1", name: "⚓ A-captain", status: "running" });
    const cfg = makeConfig();
    (cfg.projects as Record<string, unknown>).projB = { path: process.cwd(), captainName: "⚓ B-captain", spokeVault: "/spokes/b", host: "local" };
    loadConfig.mockReturnValue(cfg);
    await runPing("projA", "from the sibling");
    expect(deliverToCaptain.mock.calls[0][1]).toBe('📨 captain:projB · reply: squadrant ping projB "<msg>"\nfrom the sibling');
  });

  it("#1029: rejects a --from that could break the frame", async () => {
    await expect(runPing("projA", "x", 'a" from="captain:x')).rejects.toThrow(/Invalid --from/);
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
      "📨 cli\nhello from ping fallback",
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

  it("#786: with the channel on, ping sends through the AGENT-selected channel", async () => {
    status.mockResolvedValue({ id: "ws-1", name: "⚓ A-captain", status: "running" });
    resolveCaptainChannelMode.mockReturnValue("on");
    const opencodeChannel = { name: "opencode-http", agent: "opencode" };
    buildCaptainChannels.mockResolvedValue({
      channels: { claude: { name: "claude-peer", agent: "claude" }, opencode: opencodeChannel },
      agentFor: () => "opencode",
    });
    deliverToCaptain.mockResolvedValue({ handled: true, outcome: { status: "accepted", via: "opencode-http" } });

    await runPing("projA", "hello opencode captain");

    expect(deliverToCaptain).toHaveBeenCalledWith(
      "projA",
      "📨 cli\nhello opencode captain",
      expect.objectContaining({ mode: "on", channel: opencodeChannel })
    );
    // handled ⇒ the mailbox fallback must not double-enqueue.
    expect(appendCaptainMessage).not.toHaveBeenCalled();
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
