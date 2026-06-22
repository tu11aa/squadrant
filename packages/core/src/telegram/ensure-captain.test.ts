import { describe, it, expect, vi } from "vitest";
import { createEnsureCaptainAlive } from "./ensure-captain.js";

const fastSleep = () => Promise.resolve();

describe("ensureCaptainAlive", () => {
  it("returns alive immediately when captain is up", async () => {
    const launch = vi.fn();
    const ensure = createEnsureCaptainAlive({ isAlive: async () => true, launch, sleep: fastSleep });
    expect(await ensure("p")).toBe("alive");
    expect(launch).not.toHaveBeenCalled();
  });

  it("launches and returns launched when warmup succeeds", async () => {
    let alive = false;
    const launch = vi.fn(async () => { alive = true; });
    const ensure = createEnsureCaptainAlive({ isAlive: async () => alive, launch, sleep: fastSleep });
    expect(await ensure("p")).toBe("launched");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("returns timeout when warmup never completes", async () => {
    let t = 0;
    const ensure = createEnsureCaptainAlive({
      isAlive: async () => false, launch: async () => {}, sleep: fastSleep,
      warmupTimeoutMs: 50, pollMs: 10, now: () => (t += 20),
    });
    expect(await ensure("p")).toBe("timeout");
  });

  it("debounces concurrent calls into a single launch", async () => {
    // launch flips `alive` synchronously: relying on setTimeout under a microtask-
    // only `fastSleep` would starve the timer (the poll loop never yields to the
    // macrotask queue). The debounce guard is set synchronously, so both calls
    // share one launch regardless.
    let alive = false;
    const launch = vi.fn(async () => { alive = true; });
    const ensure = createEnsureCaptainAlive({ isAlive: async () => alive, launch, sleep: fastSleep });
    const [a, b] = await Promise.all([ensure("p"), ensure("p")]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect([a, b].every((r) => r === "launched" || r === "alive")).toBe(true);
  });
});
