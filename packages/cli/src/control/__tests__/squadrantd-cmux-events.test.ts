// src/control/__tests__/squadrantd-cmux-events.test.ts
//
// B1: the daemon wires the cmux native-events bridge additively — it starts on
// boot and stops on daemon shutdown. An injected fake keeps this off the real
// `cmux events` process (the real default is skipped under vitest).
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSquadrantd } from "../squadrantd.js";

describe("squadrantd cmux events bridge wiring", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("starts the injected bridge on boot and stops it on shutdown", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-cmuxev-"));
    const bridge = { start: vi.fn(), stop: vi.fn() };
    const handle = startSquadrantd({
      stateRoot: join(dir, "state"),
      sockPath: join(dir, "c.sock"),
      sweepMs: 0,
      cmuxEventsBridge: bridge,
    });
    stop = handle.stop;
    // Boot work runs in an async IIFE; let it flush.
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.start).toHaveBeenCalledTimes(1);

    await handle.stop();
    stop = undefined;
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });
});
