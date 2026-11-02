import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { PaneRef, RuntimeDriver } from "@squadrant/shared";
import type { ControlChannel, DeliveryOutcome } from "../control-channel.js";
import { deliverToSession, markSidePinned, sideSocketPath, threadSocketPath, type SessionDeliveryDeps } from "../session-delivery.js";
import { runSideSend } from "../side-session.js";
import { sideStateDir } from "../first-turn-init.js";
import { stateRoot } from "@squadrant/shared";

const pane: PaneRef = { workspaceId: "workspace:1", surfaceId: "surface:2" };

function deps(outcome: DeliveryOutcome | undefined, pasted: { delivered: boolean; blockedByModal?: boolean } = { delivered: true }) {
  const send = vi.fn(async () => outcome as DeliveryOutcome);
  const sendToPane = vi.fn(async () => pasted);
  const d: SessionDeliveryDeps = {
    ...(outcome ? { channel: { name: "claude-peer", agent: "claude", send, probe: vi.fn() } as ControlChannel } : {}),
    sendToPane,
  };
  return { d, send, sendToPane };
}

describe("socket paths", () => {
  it("are stable, distinct per kind/project/name, and short enough for a unix socket", () => {
    expect(sideSocketPath("app", "side-1")).toBe(sideSocketPath("app", "side-1"));
    expect(sideSocketPath("app", "side-1")).not.toBe(sideSocketPath("app", "side-2"));
    expect(sideSocketPath("app", "x")).not.toBe(threadSocketPath("app", "x"));
    expect(sideSocketPath("a-very-long-project-name".repeat(5), "weird name/∆").length).toBeLessThan(100);
  });
});

describe("deliverToSession (#1096)", () => {
  it.each<DeliveryOutcome>([
    { status: "accepted", via: "claude-peer", confirmed: true },
    { status: "accepted", via: "claude-peer", confirmed: false },
    { status: "queued", via: "claude-peer" },
    { status: "held", via: "claude-peer", reason: "approval" },
  ])("pinned: a peer %j never touches the pane", async (outcome) => {
    const { d, send, sendToPane } = deps(outcome);
    const r = await deliverToSession(pane, "/tmp/cc-socks/x.sock", true, "hi", d);
    expect(r.via).toBe("peer");
    expect(send).toHaveBeenCalledWith("/tmp/cc-socks/x.sock", "hi");
    expect(sendToPane).not.toHaveBeenCalled();
  });

  it.each<DeliveryOutcome>([{ status: "gone" }, { status: "unsupported" }])("pinned + %j throws and never touches the pane", async (outcome) => {
    const { d, sendToPane } = deps(outcome);
    await expect(deliverToSession(pane, "/s", true, "hi", d)).rejects.toThrow(/no longer running/);
    expect(sendToPane).not.toHaveBeenCalled();
  });

  it("pinned with no channel throws and never touches the pane", async () => {
    const { d, sendToPane } = deps(undefined);
    await expect(deliverToSession(pane, "/s", true, "hi", d)).rejects.toThrow(/peer channel is unavailable/);
    expect(sendToPane).not.toHaveBeenCalled();
  });

  it("unpinned: goes through the chokepoint and never opens the channel", async () => {
    const { d, send, sendToPane } = deps({ status: "gone" });
    expect((await deliverToSession(pane, "/s", false, "hi", d)).via).toBe("pane");
    expect(sendToPane).toHaveBeenCalledWith(pane, "hi");
    expect(send).not.toHaveBeenCalled();
  });

  it("unpinned: a failed fallback throws instead of reporting a paste", async () => {
    await expect(deliverToSession(pane, "/s", false, "hi", deps(undefined, { delivered: false }).d)).rejects.toThrow(/not delivered/);
    await expect(deliverToSession(pane, "/s", false, "hi", deps(undefined, { delivered: false, blockedByModal: true }).d)).rejects.toThrow(/open dialog/);
  });

  it("reports an unconfirmed accept and a held message honestly", async () => {
    expect((await deliverToSession(pane, "/s", true, "hi", deps({ status: "accepted", via: "claude-peer", confirmed: false }).d)).detail).toMatch(/no turn observed/);
    expect((await deliverToSession(pane, "/s", true, "hi", deps({ status: "held", via: "claude-peer", reason: "approval" }).d)).detail).toMatch(/held: approval/);
  });
});

describe("runSideSend", () => {
  const runtime = { listSurfaces: async () => [{ ...pane, title: "🗒 app:side-1" }] } as unknown as RuntimeDriver;
  const withRoot = async (pin: boolean, fn: () => Promise<void>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "side-pin-"));
    const prev = process.env.SQUADRANT_STATE_DIR;
    process.env.SQUADRANT_STATE_DIR = root;
    try {
      if (pin) markSidePinned(sideStateDir(stateRoot(), "app", "side-1"), sideSocketPath("app", "side-1"));
      await fn();
    } finally {
      if (prev === undefined) delete process.env.SQUADRANT_STATE_DIR; else process.env.SQUADRANT_STATE_DIR = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  it("pinned: delivers the framed message over the socket", () => withRoot(true, async () => {
    const { d, send } = deps({ status: "accepted", via: "claude-peer", confirmed: true });
    const r = await runSideSend(runtime, "workspace:1", "app", "side-1", "follow-up", d);
    expect(r.via).toBe("peer");
    expect(send).toHaveBeenCalledWith(sideSocketPath("app", "side-1"), "📨 captain:app → side.send\nfollow-up");
  }));

  it("pinned + socket gone: throws and the pane is never touched", () => withRoot(true, async () => {
    const { d, sendToPane } = deps({ status: "gone" });
    await expect(runSideSend(runtime, "workspace:1", "app", "side-1", "$(touch /tmp/x)", d)).rejects.toThrow(/no longer running/);
    expect(sendToPane).not.toHaveBeenCalled();
  }));

  it("unpinned + gone: falls back through the chokepoint", () => withRoot(false, async () => {
    const ok = deps({ status: "gone" });
    expect((await runSideSend(runtime, "workspace:1", "app", "side-1", "m", ok.d)).via).toBe("pane");
    expect(ok.sendToPane).toHaveBeenCalledWith(expect.objectContaining(pane), "📨 captain:app → side.send\nm");
  }));

  it("errors on an unknown session", async () => {
    const rt = { listSurfaces: async () => [] } as unknown as RuntimeDriver;
    await expect(runSideSend(rt, "workspace:1", "app", "nope", "m", deps(undefined).d)).rejects.toThrow(/not found/);
  });
});
