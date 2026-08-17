// #667 slice 2: flag-position behaviour of the control channel inside runCrewSend.
// Everything is injected — no runtime, no daemon, no HTTP.
import { describe, it, expect, vi } from "vitest";
import { runCrewSend } from "../crew-spawn.js";
import type { ControlChannel, DeliveryOutcome } from "../control-channel.js";

const PROJECT = "proj";
const NAME = "crew-1";

function makeChannel(over: Partial<ControlChannel> = {}): ControlChannel {
  return {
    name: "opencode-http", agent: "opencode",
    send: async () => ({ status: "accepted", via: "opencode-http" }) as DeliveryOutcome,
    probe: async () => ({ status: "reachable", via: "opencode-http" }),
    ...over,
  } as ControlChannel;
}

/** Minimal runtime + deps harness; sendToPane records whether the pane was used. */
function harness(opts: {
  mode?: "off" | "shadow" | "on";
  channel?: ControlChannel;
  paneDelivered?: boolean;
} = {}) {
  const logs: string[] = [];
  const sendToPane = vi.fn(async () => ({ delivered: opts.paneDelivered ?? true }));
  const runtime = {
    listPanes: async () => [{ paneId: "p1", title: `🔧 ${PROJECT}:${NAME}` }],
    listSurfaces: async () => [{ id: "p1", title: `🔧 ${PROJECT}:${NAME}`, command: "" }],
    sendToPane: async () => {},
    readPaneScreen: async () => "",
  } as never;
  const deps = {
    listTasks: async () => [{ id: "t1", name: NAME, project: PROJECT, state: "working",
                              provider: "opencode", createdAt: 1, serverPort: 4096 }],
    emitEvent: async () => {},
    sendToPane,
    controlChannel: opts.channel ?? makeChannel(),
    controlChannelMode: () => opts.mode ?? "off",
    onChannelLog: (m: string) => logs.push(m),
  } as never;
  return { runtime, deps, sendToPane, logs };
}

describe("runCrewSend — mode: off", () => {
  it("never touches the channel", async () => {
    const send = vi.fn();
    const probe = vi.fn();
    const { runtime, deps, sendToPane } = harness({
      mode: "off", channel: makeChannel({ send, probe }),
    });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(send).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(sendToPane).toHaveBeenCalledOnce();
  });
});

describe("runCrewSend — mode: shadow", () => {
  it("sends through the pane exactly once and never through the channel", async () => {
    // The whole point: shadow must NOT double-deliver.
    const send = vi.fn();
    const probe = vi.fn(async () => ({ status: "reachable" as const, via: "opencode-http" as const }));
    const { runtime, deps, sendToPane } = harness({
      mode: "shadow", channel: makeChannel({ send, probe }),
    });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(sendToPane).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledOnce();
  });

  it("logs a disagreement when the pane says not-delivered but the session is alive", async () => {
    // This is the countable evidence for #514/#657.
    const { runtime, deps, logs } = harness({ mode: "shadow", paneDelivered: false });
    await expect(runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps)).rejects.toThrow(/not delivered/);
    expect(logs.join("\n")).toMatch(/disagree/i);
  });

  it("logs agreement without noise when both paths concur", async () => {
    const { runtime, deps, logs } = harness({ mode: "shadow", paneDelivered: true });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(logs.join("\n")).not.toMatch(/disagree/i);
  });

  it("still throws on pane failure — shadow never changes behaviour", async () => {
    const { runtime, deps } = harness({ mode: "shadow", paneDelivered: false });
    await expect(runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps)).rejects.toThrow();
  });
});

describe("runCrewSend — mode: on", () => {
  it("delivers through the channel and does not touch the pane on accepted", async () => {
    const { runtime, deps, sendToPane } = harness({ mode: "on" });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(sendToPane).not.toHaveBeenCalled();
  });

  it("treats queued as success — it arrived, the agent is just mid-turn", async () => {
    // #657's exact shape. Falling back here would duplicate the message.
    const { runtime, deps, sendToPane } = harness({
      mode: "on",
      channel: makeChannel({ send: async () => ({ status: "queued", via: "opencode-http" }) }),
    });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(sendToPane).not.toHaveBeenCalled();
  });

  it("falls back to the pane exactly once on gone, and logs why", async () => {
    const { runtime, deps, sendToPane, logs } = harness({
      mode: "on",
      channel: makeChannel({ send: async () => ({ status: "gone" }) }),
    });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(sendToPane).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("gone");
  });

  it("falls back on unsupported and logs why — a silent fallback is forbidden", async () => {
    const { runtime, deps, sendToPane, logs } = harness({
      mode: "on",
      channel: makeChannel({ send: async () => ({ status: "unsupported" }) }),
    });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(sendToPane).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("no control channel");
  });

  it("surfaces held to the operator and never retries or falls back", async () => {
    const { runtime, deps, sendToPane } = harness({
      mode: "on",
      channel: makeChannel({
        send: async () => ({ status: "held", via: "opencode-http", reason: "awaiting approval" }),
      }),
    });
    await expect(runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps)).rejects.toThrow(/awaiting approval/);
    expect(sendToPane).not.toHaveBeenCalled();
  });

  it("never sends twice — one accepted send means one delivery", async () => {
    const send = vi.fn(async () => ({ status: "accepted" as const, via: "opencode-http" as const }));
    const { runtime, deps, sendToPane } = harness({ mode: "on", channel: makeChannel({ send }) });
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(send).toHaveBeenCalledOnce();
    expect(sendToPane).not.toHaveBeenCalled();
  });
});

describe("runCrewSend — mode resolution is per-agent", () => {
  it("uses the crew's provider to choose the mode", async () => {
    const modeFor = vi.fn(() => "off" as const);
    const { runtime, deps } = harness({});
    (deps as { controlChannelMode: unknown }).controlChannelMode = modeFor;
    await runCrewSend(PROJECT, NAME, "hi", runtime, "ws", deps);
    expect(modeFor).toHaveBeenCalledWith("opencode");
  });
});