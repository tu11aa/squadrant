import { describe, it, expect } from "vitest";
import { restartDaemonIfRunning } from "../restart-daemon.js";

const base = { reason: "x", env: {} as NodeJS.ProcessEnv };

describe("restartDaemonIfRunning", () => {
  it("opt-out via noRestart", () => {
    let ran = false;
    expect(
      restartDaemonIfRunning({
        ...base,
        noRestart: true,
        isRunning: () => true,
        runKickstart: () => { ran = true; },
      }),
    ).toBe("skipped-opt-out");
    expect(ran).toBe(false);
  });

  it("skips when daemon not running", () => {
    let ran = false;
    expect(
      restartDaemonIfRunning({
        ...base,
        isRunning: () => false,
        runKickstart: () => { ran = true; },
      }),
    ).toBe("skipped-not-running");
    expect(ran).toBe(false);
  });

  it("restarts when running", () => {
    let ran = false;
    expect(
      restartDaemonIfRunning({
        ...base,
        isRunning: () => true,
        runKickstart: () => { ran = true; },
      }),
    ).toBe("restarted");
    expect(ran).toBe(true);
  });

  it("never restarts under VITEST env", () => {
    let ran = false;
    expect(
      restartDaemonIfRunning({
        reason: "x",
        env: { VITEST: "1" } as NodeJS.ProcessEnv,
        isRunning: () => true,
        runKickstart: () => { ran = true; },
      }),
    ).toBe("skipped-opt-out");
    expect(ran).toBe(false);
  });
});
