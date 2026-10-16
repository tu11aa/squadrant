import { describe, it, expect, vi } from "vitest";
import { runKnowledgeTick } from "../squadrantd.js";

// #982 review 4: the hourly profile bridge must not depend on the KB reconcile scheduler.
describe("runKnowledgeTick", () => {
  it("runs the profile bridge even when the schedule tick throws, and logs the failure", async () => {
    const log = vi.fn();
    const bridge = vi.fn(async () => {});
    await runKnowledgeTick({ schedule: async () => { throw new Error("schedule boom"); }, bridge, log });
    expect(bridge).toHaveBeenCalledOnce();
    expect(log.mock.calls.join()).toMatch(/schedule boom/);
  });
  it("a throwing bridge is logged, never rethrown", async () => {
    const log = vi.fn();
    await expect(runKnowledgeTick({ schedule: async () => {}, bridge: async () => { throw new Error("bridge boom"); }, log })).resolves.toBeUndefined();
    expect(log.mock.calls.join()).toMatch(/bridge boom/);
  });
});
