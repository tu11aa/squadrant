// src/control/__tests__/cockpitd-cmux-autoconfig.test.ts
//
// #348: the daemon runs the cmux socket auto-config re-check on boot ONLY when
// daemon-direct is opt-in ON. With the relay default (flag OFF) it must be a
// no-op — it must never touch the user's cmux.json or spawn the orphan probe.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import type { AutoConfigResult } from "@cockpit/shared";

const okResult: AutoConfigResult = {
  configPath: "/tmp/cmux.json",
  configChanged: false,
  configAlreadySet: true,
  verdict: "reachable",
  needsRestart: false,
  promptedThisRun: false,
};

describe("cockpitd cmux autoconfig re-check (#348)", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(async () => { await stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("runs the re-check on boot when daemonDirectCmux is ON", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-autoconf-on-"));
    const runCmuxAutoConfig = vi.fn(async () => okResult);
    const handle = startCockpitd({
      stateRoot: join(dir, "state"),
      sockPath: join(dir, "c.sock"),
      sweepMs: 0,
      daemonDirectCmux: true,
      daemonCmux: { isAvailable: async () => false, listSurfaces: async () => [] } as any,
      makeDaemonCmux: () => ({ isAvailable: async () => false, listSurfaces: async () => [] }) as any,
      runCmuxAutoConfig,
    });
    stop = handle.stop;
    await new Promise((r) => setTimeout(r, 50));
    expect(runCmuxAutoConfig).toHaveBeenCalledTimes(1);
  });

  it("does NOT run the re-check when daemonDirectCmux is OFF (relay default)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-autoconf-off-"));
    const runCmuxAutoConfig = vi.fn(async () => okResult);
    const handle = startCockpitd({
      stateRoot: join(dir, "state"),
      sockPath: join(dir, "c.sock"),
      sweepMs: 0,
      daemonDirectCmux: false,
      runCmuxAutoConfig,
    });
    stop = handle.stop;
    await new Promise((r) => setTimeout(r, 50));
    expect(runCmuxAutoConfig).not.toHaveBeenCalled();
  });
});
