import { describe, it, expect, vi } from "vitest";
import { ClaudePeerChannel } from "../peer-channel.js";

/** Minimal deps: nothing touches a real socket, clock, or filesystem. */
function mk(over: Partial<ConstructorParameters<typeof ClaudePeerChannel>[0]> = {}) {
  const base = {
    socketPathFor: (_t: string) => "/tmp/cc-socks/crew.sock",
    sessionIdFor: (_t: string) => "ses_abc",
    statusFor: vi.fn().mockReturnValue({ status: "idle", statusUpdatedAt: 1 }),
    wire: vi.fn().mockResolvedValue({ ok: true }),
    receipts: { address: "uds:/tmp/cc-socks/squadrantd.sock", waitFor: vi.fn().mockResolvedValue(undefined) },
    newMsgId: () => "m-1",
    sleep: vi.fn().mockResolvedValue(undefined),
    confirmWindowMs: 100,
  };
  return new ClaudePeerChannel({ ...base, ...over } as any);
}

describe("ClaudePeerChannel.send", () => {
  it("returns unsupported when the task has no socket path", async () => {
    const ch = mk({ socketPathFor: () => undefined });
    expect(await ch.send("t1", "hi")).toEqual({ status: "unsupported" });
  });

  it("returns gone when nothing is listening", async () => {
    const ch = mk({ wire: vi.fn().mockResolvedValue({ ok: false, reason: "gone", error: "ENOENT" }) });
    expect(await ch.send("t1", "hi")).toEqual({ status: "gone" });
  });

  it("held wins over a status flip — a held receipt is authoritative", async () => {
    const ch = mk({
      receipts: {
        address: "uds:/x.sock",
        waitFor: vi.fn().mockResolvedValue({ status: "held", reason: "parity", origMsgId: "m-1" }),
      },
      statusFor: vi.fn().mockReturnValue({ status: "busy", statusUpdatedAt: 2 }),
    });
    expect(await ch.send("t1", "hi")).toEqual({ status: "held", via: "claude-peer", reason: "parity" });
  });

  it("confirms via the T1 idle->busy flip when no receipt arrives", async () => {
    // idle at send time, busy after -> the injected message started a turn.
    const statusFor = vi.fn()
      .mockReturnValueOnce({ status: "idle", statusUpdatedAt: 1 })
      .mockReturnValue({ status: "busy", statusUpdatedAt: 2 });
    const ch = mk({ statusFor });
    expect(await ch.send("t1", "hi")).toEqual({ status: "accepted", via: "claude-peer", confirmed: true });
  });

  it("confirms via statusUpdatedAt advanced, even if status returned to idle", async () => {
    // idle at send time, idle after -> but statusUpdatedAt advanced -> confirmed!
    const statusFor = vi.fn()
      .mockReturnValueOnce({ status: "idle", statusUpdatedAt: 1 })
      .mockReturnValue({ status: "idle", statusUpdatedAt: 2 });
    const ch = mk({ statusFor });
    expect(await ch.send("t1", "hi")).toEqual({ status: "accepted", via: "claude-peer", confirmed: true });
  });

  it("records accepted-unconfirmed when statusUpdatedAt missing and status stays idle", async () => {
    const wire = vi.fn().mockResolvedValue({ ok: true });
    const statusFor = vi.fn()
      .mockReturnValueOnce({ status: "idle", statusUpdatedAt: undefined })
      .mockReturnValue({ status: "idle", statusUpdatedAt: undefined });
    const ch = mk({ wire, statusFor });
    expect(await ch.send("t1", "hi")).toEqual({ status: "accepted", via: "claude-peer", confirmed: false });
    expect(wire).toHaveBeenCalledTimes(1);   // the 30 s dedup rule
  });

  it("treats an already-busy session as accepted-unconfirmed, never as a flip", async () => {
    // Busy before AND after tells us nothing — refusing to claim confirmation
    // here is the whole point of not inferring.
    const ch = mk({ statusFor: vi.fn().mockReturnValue({ status: "busy", statusUpdatedAt: 1 }) });
    expect(await ch.send("t1", "hi")).toEqual({ status: "accepted", via: "claude-peer", confirmed: false });
  });

  it("puts its own receipt address in from, and never a from-mode", async () => {
    const wire = vi.fn().mockResolvedValue({ ok: true });
    const ch = mk({ wire });
    await ch.send("t1", "hi");
    const envelope = wire.mock.calls[0][1] as Record<string, unknown>;
    expect(envelope.from).toBe("uds:/tmp/cc-socks/squadrantd.sock");
    expect(envelope.session_id).toBe("ses_abc");
    expect("from-mode" in envelope).toBe(false);
  });

  it("does not retry a transport error itself — the caller owns retry policy", async () => {
    const wire = vi.fn().mockResolvedValue({ ok: false, reason: "transport", error: "timeout" });
    const ch = mk({ wire });
    expect(await ch.send("t1", "hi")).toEqual({ status: "gone" });
    expect(wire).toHaveBeenCalledTimes(1);
  });
});

describe("ClaudePeerChannel.probe", () => {
  it("is reachable when the registry knows the session", async () => {
    const ch = mk({ statusFor: vi.fn().mockReturnValue({ status: "idle", statusUpdatedAt: 1 }) });
    expect(await ch.probe("t1")).toEqual({ status: "reachable", via: "claude-peer" });
  });

  it("is gone when the registry has no entry", async () => {
    const ch = mk({ statusFor: vi.fn().mockReturnValue(undefined) });
    expect(await ch.probe("t1")).toEqual({ status: "gone" });
  });

  it("is unsupported without a socket path", async () => {
    const ch = mk({ socketPathFor: () => undefined });
    expect(await ch.probe("t1")).toEqual({ status: "unsupported" });
  });

  it("writes nothing — probe MUST be non-mutating", async () => {
    const wire = vi.fn();
    const ch = mk({ wire });
    await ch.probe("t1");
    expect(wire).not.toHaveBeenCalled();
  });
});
