// src/control/__tests__/cockpitd-cmux-autoconfig.test.ts
//
// #348: the daemon runs the cmux socket auto-config re-check on boot.
// Delivery is now unconditional (daemon-direct always on) so autoconfig
// always runs — the old relay-default no-op path is gone.
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

  it("runs the re-check on boot (delivery always on — no flag required)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-autoconf-on-"));
    const runCmuxAutoConfig = vi.fn(async () => okResult);
    const handle = startCockpitd({
      stateRoot: join(dir, "state"),
      sockPath: join(dir, "c.sock"),
      sweepMs: 0,
      daemonCmux: { isAvailable: async () => false, listSurfaces: async () => [] } as any,
      makeDaemonCmux: () => ({ isAvailable: async () => false, listSurfaces: async () => [] }) as any,
      runCmuxAutoConfig,
    });
    stop = handle.stop;
    await new Promise((r) => setTimeout(r, 50));
    expect(runCmuxAutoConfig).toHaveBeenCalledTimes(1);
  });
});
