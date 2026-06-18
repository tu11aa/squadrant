import { describe, it, expect, vi } from "vitest";
import { runRelaySupervisor } from "../relay-supervisor-loop.js";

describe("runRelaySupervisor", () => {
  it("retries boot N times with backoff then returns stop-fn", async () => {
    const bootRelay = vi
      .fn()
      .mockRejectedValueOnce(new Error("boot race"))
      .mockRejectedValueOnce(new Error("boot race"))
      .mockResolvedValueOnce(() => {}); // stop-fn
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const stop = await runRelaySupervisor({
      bootRelay,
      sleep,
      log,
      delayMs: 3000,
      maxAttempts: 5,
    });

    expect(bootRelay).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(stop).toBeInstanceOf(Function);
  });

  it("returns immediately on first successful boot (0 sleeps)", async () => {
    const stopFn = () => {};
    const bootRelay = vi.fn().mockResolvedValue(stopFn);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const stop = await runRelaySupervisor({
      bootRelay,
      sleep,
      log,
      delayMs: 3000,
    });

    expect(bootRelay).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(stop).toBe(stopFn);
  });

  it("maxAttempts bounds the loop — throws after N failures", async () => {
    const bootRelay = vi.fn().mockRejectedValue(new Error("always fails"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await expect(
      runRelaySupervisor({
        bootRelay,
        sleep,
        log,
        delayMs: 100,
        maxAttempts: 2,
      }),
    ).rejects.toThrow("always fails");

    expect(bootRelay).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("shouldContinue=false exits immediately without calling bootRelay", async () => {
    const bootRelay = vi.fn();
    const sleep = vi.fn();
    const log = vi.fn();

    const result = await runRelaySupervisor({
      bootRelay,
      sleep,
      log,
      delayMs: 100,
      shouldContinue: () => false,
    });

    expect(bootRelay).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
