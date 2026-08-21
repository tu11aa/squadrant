// #709: the captain-bound channel must include session_id whenever the
// captain is resolvable in the registry, and omit it (never throw) when not.
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import { ClaudePeerChannel } from "@squadrant/agents";
import { captainSessionIdFor } from "../captain-channel-factory.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("captainSessionIdFor", () => {
  it("resolves the sessionId from the registry entry matching the captain's socket path", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["1.json"] as any);
    vi.spyOn(fs, "readFileSync").mockImplementation((path: any) => {
      if (path.toString().endsWith("1.json")) {
        return JSON.stringify({
          messagingSocketPath: "/tmp/cc-socks/squadrant-captain-demo.sock",
          sessionId: "sess-captain-1",
          status: "idle",
        });
      }
      throw new Error("ENOENT");
    });
    expect(captainSessionIdFor("demo")).toBe("sess-captain-1");
  });

  it("returns undefined, not throw, when the captain has not registered yet", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([] as any);
    expect(captainSessionIdFor("demo")).toBeUndefined();
  });
});

describe("captain envelope carries session_id end-to-end (#709)", () => {
  function channelWithSessionResolver(wire: ReturnType<typeof vi.fn>) {
    return new ClaudePeerChannel({
      socketPathFor: () => "/tmp/cc-socks/squadrant-captain-demo.sock",
      sessionIdFor: captainSessionIdFor,
      statusFor: () => ({ status: "idle", statusUpdatedAt: 1 }),
      wire,
      receipts: { address: "uds:/tmp/cc-socks/squadrantd-1.sock", waitFor: vi.fn().mockResolvedValue(undefined) },
      newMsgId: () => "m-1",
      sleep: vi.fn().mockResolvedValue(undefined),
      confirmWindowMs: 10,
    });
  }

  it("includes session_id when the captain is resolvable in the registry", async () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["1.json"] as any);
    vi.spyOn(fs, "readFileSync").mockImplementation((path: any) => {
      if (path.toString().endsWith("1.json")) {
        return JSON.stringify({
          messagingSocketPath: "/tmp/cc-socks/squadrant-captain-demo.sock",
          sessionId: "sess-captain-1",
          status: "idle",
        });
      }
      throw new Error("ENOENT");
    });
    const wire = vi.fn().mockResolvedValue({ ok: true });
    await channelWithSessionResolver(wire).send("demo", "CREW DONE: fix-706");
    const envelope = wire.mock.calls[0][1] as Record<string, unknown>;
    expect(envelope.session_id).toBe("sess-captain-1");
  });

  it("omits session_id (does not throw) when the captain is not resolvable in the registry", async () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([] as any);
    const wire = vi.fn().mockResolvedValue({ ok: true });
    await expect(channelWithSessionResolver(wire).send("demo", "CREW DONE: fix-706")).resolves.toBeDefined();
    const envelope = wire.mock.calls[0][1] as Record<string, unknown>;
    expect(envelope.session_id).toBeUndefined();
  });
});
