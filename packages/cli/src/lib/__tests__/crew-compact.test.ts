// #1051: `crew send` waits out a queued/running compact so its message lands after it.
import { describe, it, expect, vi } from "vitest";
import { requestCrewCompact, waitForCrewCompact } from "../crew-compact.js";

describe("crew compact CLI helpers", () => {
  it("waitForCrewCompact polls until the hold clears", async () => {
    const states = [true, true, false];
    const call = vi.fn(async () => ({ holding: states.shift() }));
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    await waitForCrewCompact("demo", "crew-1", { call, sleep, log });
    expect(call).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("returns at once when nothing is held, and never blocks a send on a probe failure", async () => {
    const sleep = vi.fn(async () => {});
    await waitForCrewCompact("demo", "c", { call: async () => ({ holding: false }), sleep });
    await waitForCrewCompact("demo", "c", { call: async () => { throw new Error("no daemon"); }, sleep });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws, not sends, when the compact outlasts the wait", async () => {
    await expect(
      waitForCrewCompact("demo", "c", { call: async () => ({ holding: true }), sleep: async () => {}, timeoutMs: -1 }),
    ).rejects.toThrow(/still compacting/);
  });

  it("requestCrewCompact sends keep only when given and surfaces daemon refusals", async () => {
    const call = vi.fn(async () => ({ queued: true, agent: "claude" }));
    await requestCrewCompact("demo", "c", "x", call);
    await requestCrewCompact("demo", "c", undefined, call);
    expect(call.mock.calls).toEqual([
      [{ kind: "crew-compact", project: "demo", crew: "c", keep: "x" }],
      [{ kind: "crew-compact", project: "demo", crew: "c" }],
    ]);
    await expect(requestCrewCompact("demo", "c", undefined, async () => { throw new Error("under operator takeover"); })).rejects.toThrow(/takeover/);
  });
});
