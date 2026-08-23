import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelivery } from "../delivery-loop.js";
import { createStore } from "../../store.js";
import { LivenessRegistry } from "../liveness-registry.js";
import { appendCaptainMessage } from "../../mailbox.js";
import { DeferDelivery } from "../../delivery/defer-delivery.js";
import type { DeliveryOutcome } from "../../control-channel.js";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "deliv-chan-"));
}

async function runTick(opts: {
  mode: "off" | "on" | "shadow";
  outcome?: DeliveryOutcome;
  throws?: Error;
  paneDefers?: boolean;
}) {
  const stateRoot = freshState();
  const project = "demo";
  const captainName = `${project}-captain`;
  const store = createStore(stateRoot);
  store.put({
    id: "t1", project, provider: "claude", mode: "interactive",
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

  const paneSend = vi.fn().mockImplementation(() => {
    if (opts.paneDefers) throw new DeferDelivery("captain is composing", "draft");
    return undefined;
  });

  const cmux = {
    listSurfaces: async () => [{ id: "s1", title: captainName, command: "bash" }],
    findWorkspaceId: async () => "w1",
    readScreen: async () => `${captainName}> `,
    send: paneSend
  };

  const channelSend = vi.fn().mockImplementation(() => {
    if (opts.throws) throw opts.throws;
    return opts.outcome || { status: "accepted", via: "claude-peer", confirmed: true };
  });

  const deliv = createDelivery({
    stateRoot,
    store,
    livenessRegistry,
    log: () => {},
    isPidAlive: () => true,
    opts: {},
    captainChannelMode: () => opts.mode,
    captainChannel: {
      name: "claude-peer",
      agent: "claude",
      send: channelSend,
      probe: vi.fn().mockResolvedValue({ status: "reachable", via: "claude-peer" }),
    } as any,
  } as any, cmux as any);

  let cursorAdvanced = false;
  const originalDeliveryTick = deliv.deliveryTick!;
  
  // We can measure if cursor advanced by checking if the inbox has been processed
  await originalDeliveryTick();

  const { readCursor } = await import("../../mailbox.js");
  const cursor = await readCursor({ stateRoot, project, subscriber: "captain" });
  cursorAdvanced = cursor?.lastAckedSeq === 1;

  return { paneSend, channelSend, cursorAdvanced };
}

describe("captain delivery via the control channel (#667 slice 4)", () => {
  it("off: pane send happens exactly as today", async () => {
    const { paneSend, channelSend } = await runTick({ mode: "off" });
    expect(paneSend).toHaveBeenCalledTimes(1);
    expect(channelSend).not.toHaveBeenCalled();
  });

  it("on + accepted: pane is skipped and the cursor still advances", async () => {
    const { paneSend, cursorAdvanced } = await runTick({ mode: "on", outcome: { status: "accepted", via: "claude-peer" } });
    expect(paneSend).not.toHaveBeenCalled();
    expect(cursorAdvanced).toBe(true);
  });

  it("on + gone: falls back to the pane exactly once", async () => {
    const { paneSend } = await runTick({ mode: "on", outcome: { status: "gone" } });
    expect(paneSend).toHaveBeenCalledTimes(1);
  });

  it("on + held: cursor advances and the pane is NOT used — no double-send", async () => {
    // The message is sitting in front of a human. Re-delivering via the pane
    // would put the same text in twice.
    const { paneSend, cursorAdvanced } = await runTick({ mode: "on", outcome: { status: "held", via: "claude-peer", reason: "parity" } });
    expect(paneSend).not.toHaveBeenCalled();
    expect(cursorAdvanced).toBe(true);
  });

  it("a channel throw never breaks the loop — it falls back to the pane", async () => {
    const { paneSend } = await runTick({ mode: "on", throws: new Error("socket exploded") });
    expect(paneSend).toHaveBeenCalledTimes(1);
  });

  it("existing defer behaviour is preserved when the pane defers", async () => {
    const { cursorAdvanced } = await runTick({ mode: "off", paneDefers: true });
    expect(cursorAdvanced).toBe(false);
  });
});
