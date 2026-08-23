import { describe, it, expect, vi } from "vitest";
import { captainSocketPath, deliverToCaptain } from "../captain-channel.js";

const ch = (outcome: unknown) => ({
  name: "claude-peer" as const, agent: "claude",
  send: vi.fn().mockResolvedValue(outcome),
  probe: vi.fn().mockResolvedValue({ status: "reachable", via: "claude-peer" }),
});

describe("captainSocketPath", () => {
  it("is deterministic and matches slice 3's launch formula", () => {
    expect(captainSocketPath("demo", "/tmp/cc-socks"))
      .toBe("/tmp/cc-socks/squadrant-captain-demo.sock");
  });

  it("does not let a project name escape the socket directory", () => {
    // A registered project name is operator-controlled, not attacker-controlled,
    // but a path-traversing name would silently write outside the trust boundary.
    expect(() => captainSocketPath("../../etc/passwd", "/tmp/cc-socks")).toThrow(/project name/);
  });
});

describe("deliverToCaptain", () => {
  it("off: does nothing and leaves the pane to handle it", async () => {
    const c = ch({ status: "accepted", via: "claude-peer" });
    const r = await deliverToCaptain("demo", "hi", { channel: c, mode: "off" });
    expect(r).toEqual({ handled: false });
    expect(c.send).not.toHaveBeenCalled();
  });

  it("on + accepted: handled, pane skipped", async () => {
    const c = ch({ status: "accepted", via: "claude-peer", confirmed: true });
    const r = await deliverToCaptain("demo", "hi", { channel: c, mode: "on" });
    expect(r.handled).toBe(true);
    expect(r.outcome).toEqual({ status: "accepted", via: "claude-peer", confirmed: true });
  });

  it("on + held: handled — a human must act, so the pane must NOT double-send", async () => {
    const c = ch({ status: "held", via: "claude-peer", reason: "permission-mode parity" });
    const r = await deliverToCaptain("demo", "hi", { channel: c, mode: "on" });
    expect(r.handled).toBe(true);
    expect(r.outcome).toMatchObject({ status: "held" });
  });

  it("on + gone: NOT handled, so the caller falls back to the pane exactly once", async () => {
    const c = ch({ status: "gone" });
    const logs: string[] = [];
    const r = await deliverToCaptain("demo", "hi", { channel: c, mode: "on", log: (m) => logs.push(m) });
    expect(r).toEqual({ handled: false, outcome: { status: "gone" } });
    expect(logs.join("\n")).toContain("falling back to pane");   // never a silent fallback
  });

  it("on with no channel injected: not handled, logged as unsupported", async () => {
    const r = await deliverToCaptain("demo", "hi", { mode: "on" });
    expect(r.handled).toBe(false);
  });

  it("shadow: probes only, never sends, and never handles", async () => {
    const c = ch({ status: "accepted", via: "claude-peer" });
    const logs: string[] = [];
    const r = await deliverToCaptain("demo", "hi", { channel: c, mode: "shadow", log: (m) => logs.push(m) });
    expect(c.send).not.toHaveBeenCalled();          // shadow must never deliver
    expect(c.probe).toHaveBeenCalledTimes(1);
    expect(r.handled).toBe(false);                  // the pane still decides
    expect(logs.join("\n")).toMatch(/captain-channel .*(reachable|agree|DISAGREEMENT)/);
  });
});
