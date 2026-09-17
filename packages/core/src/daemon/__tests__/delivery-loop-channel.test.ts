// #786: the daemon must pick the captain-bound channel by the captain's AGENT
// (launch record, else config) rather than assuming claude. Modelled on
// delivery-loop.captain-channel.test.ts — same harness shape, extra agent fields.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelivery } from "../delivery-loop.js";
import { createStore } from "../../store.js";
import { LivenessRegistry } from "../liveness-registry.js";
import { appendCaptainMessage } from "../../mailbox.js";
import type { ControlChannel } from "../../control-channel.js";

async function runTick(opts: {
  mode: "off" | "on" | "shadow";
  channels?: Record<string, ControlChannel>;
  agentFor?: (project: string) => string | undefined;
}) {
  const stateRoot = mkdtempSync(join(tmpdir(), "deliv-chan786-"));
  const project = "demo";
  const captainName = `${project}-captain`;
  const store = createStore(stateRoot);
  store.put({
    id: "t1", project, provider: "opencode", mode: "interactive",
    state: "submitted", task: "t", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000, attempts: []
  });

  const livenessRegistry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
  livenessRegistry.apply({
    project, role: "captain", pid: 123, sessionId: "s1",
    startedAt: Date.now(), lastState: "start", lastSeenAt: Date.now(),
    pidAlive: true, source: "runtime"
  });

  await appendCaptainMessage({ stateRoot, project, text: "hello", source: "cli" });

  // The pane must never be touched when an agent channel is selected.
  const paneSend = vi.fn(() => { throw new Error("pane send must not be called"); });

  const cmux = {
    listSurfaces: async () => [{ id: "s1", title: captainName, command: "opencode" }],
    findWorkspaceId: async () => "w1",
    readScreen: async () => `${captainName}> `,
    send: paneSend,
  };

  const opencodeSend = vi.fn(async () => ({ status: "accepted", via: "opencode-http" }));
  const channels: Record<string, ControlChannel> = opts.channels ?? {
    opencode: {
      name: "opencode-http",
      agent: "opencode",
      send: opencodeSend,
      probe: vi.fn(async () => ({ status: "reachable", via: "opencode-http" })),
    } as unknown as ControlChannel,
  };

  const deliv = createDelivery({
    stateRoot,
    store,
    livenessRegistry,
    log: () => {},
    isPidAlive: () => true,
    opts: {},
    telegramBridge: undefined,
    captainChannelMode: () => opts.mode,
    captainChannels: channels,
    captainAgentFor: opts.agentFor ?? (() => "opencode"),
  } as any, cmux as any);

  await deliv.deliveryTick!();

  return { paneSend, opencodeSend, stats: deliv.deliveryStats(project) };
}

describe("agent-aware captain delivery (#786)", () => {
  it("delivers over the opencode channel and never touches the pane", async () => {
    const { paneSend, opencodeSend } = await runTick({ mode: "on" });
    expect(paneSend).not.toHaveBeenCalled();
    expect(opencodeSend).toHaveBeenCalledTimes(1);
  });

  it("defers with reason no-channel (never the pane) when the captain has no channel", async () => {
    const { paneSend, stats } = await runTick({ mode: "on", channels: {} });
    expect(paneSend).not.toHaveBeenCalled();
    expect(stats?.reason).toBe("no-channel");
    // Immediate: not after maxDefers — nothing in the pane can clear it.
    expect(stats?.stuck).toBe(true);
  });

  it("keeps the legacy single-channel path when no agent resolver is injected", async () => {
    const state = mkdtempSync(join(tmpdir(), "deliv-chan786-legacy-"));
    const project = "demo";
    const store = createStore(state);
    store.put({
      id: "t1", project, provider: "claude", mode: "interactive",
      state: "submitted", task: "t", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000, attempts: []
    });
    const livenessRegistry = new LivenessRegistry({ path: join(state, "live.json") });
    livenessRegistry.apply({
      project, role: "captain", pid: 123, sessionId: "s1",
      startedAt: Date.now(), lastState: "start", lastSeenAt: Date.now(),
      pidAlive: true, source: "runtime"
    });
    await appendCaptainMessage({ stateRoot: state, project, text: "hello", source: "cli" });

    const paneSend = vi.fn();
    const claudeSend = vi.fn(async () => ({ status: "accepted", via: "claude-peer" }));
    const deliv = createDelivery({
      stateRoot: state,
      store,
      livenessRegistry,
      log: () => {},
      isPidAlive: () => true,
      opts: {},
      telegramBridge: undefined,
      captainChannelMode: () => "on",
      captainChannel: {
        name: "claude-peer", agent: "claude", send: claudeSend,
        probe: vi.fn(async () => ({ status: "reachable", via: "claude-peer" })),
      } as unknown as ControlChannel,
    } as any, {
      listSurfaces: async () => [{ id: "s1", title: `${project}-captain`, command: "claude" }],
      findWorkspaceId: async () => "w1",
      readScreen: async () => "",
      send: paneSend,
    } as any);

    await deliv.deliveryTick!();
    expect(claudeSend).toHaveBeenCalledTimes(1);
    expect(paneSend).not.toHaveBeenCalled();
  });
});
