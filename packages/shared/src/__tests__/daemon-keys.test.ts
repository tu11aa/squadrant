import { describe, it, expect } from "vitest";
import { isDaemonCachedKey } from "../daemon-keys.js";

describe("isDaemonCachedKey", () => {
  it("flags daemon-cached keys", () => {
    for (const k of [
      "telegram.remoteControl",
      "telegram.notify.crew",
      "defaults.taskTimeoutMs",
      "defaults.cmuxEventsBridge",
      "defaults.router",
      "defaults.router.baseUrl",
      "projects.brove",
    ]) {
      expect(isDaemonCachedKey(k), k).toBe(true);
    }
  });

  it("treats defaults.router as daemon-cached (config set restarts the daemon)", () => {
    expect(isDaemonCachedKey("defaults.router")).toBe(true);
    expect(isDaemonCachedKey("defaults.router.baseUrl")).toBe(true);
  });

  it("ignores fresh-read keys", () => {
    for (const k of [
      "defaults.effort",
      "defaults.crewRouting.rules",
      "models.crew",
    ]) {
      expect(isDaemonCachedKey(k), k).toBe(false);
    }
  });
});
