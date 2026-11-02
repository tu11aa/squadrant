import { describe, it, expect, vi } from "vitest";
import type { PaneRef, RuntimeDriver } from "@squadrant/shared";
import type { ControlChannel, DeliveryOutcome } from "../control-channel.js";
import { deliverToSession, sideSocketPath, threadSocketPath, type SessionDeliveryDeps } from "../session-delivery.js";
import { runSideSend } from "../side-session.js";

const pane: PaneRef = { workspaceId: "workspace:1", surfaceId: "surface:2" };

function deps(outcome: DeliveryOutcome | undefined, pasted: { delivered: boolean; blockedByModal?: boolean } = { delivered: true }, socketExists = false) {
  const send = vi.fn(async () => outcome as DeliveryOutcome);
  const sendToPane = vi.fn(async () => pasted);
  const d: SessionDeliveryDeps = {
    ...(outcome ? { channel: { name: "claude-peer", agent: "claude", send, probe: vi.fn() } as ControlChannel } : {}),
    sendToPane,
    socketExists: () => socketExists,
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
  ])("a peer %j never touches the pane", async (outcome) => {
    const { d, send, sendToPane } = deps(outcome);
    const r = await deliverToSession(pane, "/tmp/cc-socks/x.sock", "hi", d);
    expect(r.via).toBe("peer");
    expect(send).toHaveBeenCalledWith("/tmp/cc-socks/x.sock", "hi");
    expect(sendToPane).not.toHaveBeenCalled();
  });

  it.each<DeliveryOutcome>([{ status: "gone" }, { status: "unsupported" }])("%j falls back through the chokepoint", async (outcome) => {
    const { d, sendToPane } = deps(outcome);
    expect((await deliverToSession(pane, "/s", "hi", d)).via).toBe("pane");
    expect(sendToPane).toHaveBeenCalledWith(pane, "hi");
  });

  it("a pinned socket that refuses the message errors and never pastes into the pane", async () => {
    const { d, sendToPane } = deps({ status: "gone" }, { delivered: true }, true);
    await expect(deliverToSession(pane, "/s", "hi", d)).rejects.toThrow(/peer socket did not accept/);
    expect(sendToPane).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed accept and a held message honestly", async () => {
    expect((await deliverToSession(pane, "/s", "hi", deps({ status: "accepted", via: "claude-peer", confirmed: false }).d)).detail).toMatch(/no turn observed/);
    expect((await deliverToSession(pane, "/s", "hi", deps({ status: "held", via: "claude-peer", reason: "approval" }).d)).detail).toMatch(/held: approval/);
  });

  it("with no channel it goes straight to the chokepoint", async () => {
    const { d, sendToPane } = deps(undefined);
    expect((await deliverToSession(pane, "/s", "hi", d)).via).toBe("pane");
    expect(sendToPane).toHaveBeenCalledTimes(1);
  });

  it("a failed fallback throws instead of reporting a paste", async () => {
    await expect(deliverToSession(pane, "/s", "hi", deps({ status: "gone" }, { delivered: false }).d)).rejects.toThrow(/not delivered/);
    await expect(deliverToSession(pane, "/s", "hi", deps({ status: "gone" }, { delivered: false, blockedByModal: true }).d)).rejects.toThrow(/open dialog/);
  });
});

describe("runSideSend", () => {
  const runtime = { listSurfaces: async () => [{ ...pane, title: "🗒 app:side-1" }] } as unknown as RuntimeDriver;

  it("delivers the framed message over the pinned socket", async () => {
    const { d, send } = deps({ status: "accepted", via: "claude-peer", confirmed: true });
    const r = await runSideSend(runtime, "workspace:1", "app", "side-1", "follow-up", d);
    expect(r.via).toBe("peer");
    expect(send).toHaveBeenCalledWith(sideSocketPath("app", "side-1"), "📨 captain:app → side.send\nfollow-up");
  });

  it("falls back to the chokepoint with no socket, and throws when that fails", async () => {
    const ok = deps({ status: "gone" });
    expect((await runSideSend(runtime, "workspace:1", "app", "side-1", "m", ok.d)).via).toBe("pane");
    expect(ok.sendToPane).toHaveBeenCalledWith(expect.objectContaining(pane), "📨 captain:app → side.send\nm");
    await expect(runSideSend(runtime, "workspace:1", "app", "side-1", "m", deps({ status: "gone" }, { delivered: false }).d)).rejects.toThrow(/not delivered/);
  });

  it("errors on an unknown session", async () => {
    const rt = { listSurfaces: async () => [] } as unknown as RuntimeDriver;
    await expect(runSideSend(rt, "workspace:1", "app", "nope", "m", deps(undefined).d)).rejects.toThrow(/not found/);
  });
});
