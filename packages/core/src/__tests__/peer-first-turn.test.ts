import { describe, it, expect, vi } from "vitest";
import { deliverFirstTurnViaPeer, screenShowsTrustPanel, trustPanelAcceptKeys, type PeerFirstTurnDeps } from "../peer-first-turn.js";
import type { DeliveryOutcome } from "../control-channel.js";

function mk(over: Partial<PeerFirstTurnDeps> = {}) {
  let t = 0;
  const deps: PeerFirstTurnDeps = {
    statusOf: () => ({ status: "idle" }),
    readScreen: async () => "",
    pressKey: vi.fn(async () => {}),
    send: vi.fn(async (): Promise<DeliveryOutcome> => ({ status: "accepted", via: "claude-peer", confirmed: true })),
    isConfirmed: async () => false,
    sleep: async (ms) => { t += ms; },
    now: () => t,
    readyTimeoutMs: 1_000,
    pollMs: 100,
    confirmGraceMs: 500,
    ...over,
  };
  return deps;
}

describe("screenShowsTrustPanel", () => {
  it("matches the folder-trust panel", () => {
    expect(screenShowsTrustPanel("Do you trust the files in this folder?\n❯ 1. Yes, proceed")).toBe(true);
    expect(screenShowsTrustPanel("Accessing workspace:\n /x\nQuick safety check: Is this a project you trust?")).toBe(true);
    expect(screenShowsTrustPanel("Quick safety check: Is this a project you created or one you trust? (Like your own code")).toBe(true);
    expect(screenShowsTrustPanel("❯ \n? for shortcuts")).toBe(false);
  });

  it("steps to Yes when the cursor defaults to 'No, exit' (bare Enter would quit claude)", () => {
    expect(trustPanelAcceptKeys(" ❯ No, exit\n   Yes, I trust this folder")).toEqual(["Down", "Enter"]);
    expect(trustPanelAcceptKeys("❯ 1. Yes, proceed\n  2. No, exit")).toEqual(["Enter"]);
  });
});

describe("deliverFirstTurnViaPeer", () => {
  it("sends immediately when registry is idle and reports delivered on confirmed accept", async () => {
    const d = mk();
    expect(await deliverFirstTurnViaPeer("brief\nline2", d)).toEqual({ kind: "delivered" });
    expect(d.send).toHaveBeenCalledWith("brief\nline2");
    expect(d.pressKey).not.toHaveBeenCalled();
  });

  it("answers the trust panel while no registry entry exists, then sends once idle", async () => {
    let polls = 0;
    const d = mk({
      statusOf: () => (++polls > 3 ? { status: "idle" } : undefined),
      readScreen: async () => (polls <= 3 ? "Do you trust the files in this folder?\n❯ 1. Yes, proceed" : ""),
    });
    expect((await deliverFirstTurnViaPeer("b", d)).kind).toBe("delivered");
    expect(d.pressKey).toHaveBeenCalled();
  });

  it("does not hammer the trust panel every poll", async () => {
    let polls = 0;
    const d = mk({
      statusOf: () => (++polls > 6 ? { status: "idle" } : undefined),
      readScreen: async () => "Do you trust the files in this folder?\n❯ 1. Yes, proceed",
    });
    await deliverFirstTurnViaPeer("b", d);
    expect((d.pressKey as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThan(3);
  });

  it("falls back (no send) when the registry never reports idle", async () => {
    const d = mk({ statusOf: () => undefined });
    expect(await deliverFirstTurnViaPeer("b", d)).toEqual({ kind: "fallback" });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("falls back on gone / unsupported", async () => {
    for (const status of ["gone", "unsupported"] as const) {
      const d = mk({ send: vi.fn(async () => ({ status }) as DeliveryOutcome) });
      expect(await deliverFirstTurnViaPeer("b", d)).toEqual({ kind: "fallback" });
    }
  });

  it("accepted-unconfirmed is NOT a fallback: waits for the hook receipt, never re-pastes", async () => {
    let n = 0;
    const d = mk({
      send: vi.fn(async () => ({ status: "accepted", via: "claude-peer", confirmed: false }) as DeliveryOutcome),
      isConfirmed: async () => ++n >= 2,
    });
    expect(await deliverFirstTurnViaPeer("b", d)).toEqual({ kind: "delivered" });
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("accepted but never confirmed ⇒ unconfirmed (caller must not paste a duplicate)", async () => {
    const d = mk({ send: vi.fn(async () => ({ status: "queued", via: "claude-peer" }) as DeliveryOutcome) });
    expect(await deliverFirstTurnViaPeer("b", d)).toEqual({ kind: "unconfirmed" });
  });
});
