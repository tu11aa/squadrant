// #589: on boot, the daemon reads back the previous exit marker (if any) and
// surfaces the gap between that exit and now — a restart's cause and the
// awake-time gap must never be silent. Complements squadrantd-boot-marker.test.ts
// (which covers the marker being WRITTEN on stop()).
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeExitMarker, readFromCursor, exitMarkerPath,
  writeRunningMarker, readRunningMarker, runningMarkerPath,
} from "@squadrant/core";
import { startSquadrantd } from "../squadrantd.js";

/** A marker written by a PRIOR daemon session already implies its stateRoot
 *  existed — mkdir it first, mirroring what buildContext() does on every real
 *  boot, so writeExitMarker isn't silently dropped by a missing directory. */
function seedMarker(stateRoot: string, marker: Parameters<typeof writeExitMarker>[1]) {
  mkdirSync(stateRoot, { recursive: true });
  writeExitMarker(stateRoot, marker, () => {});
}

function seedRunningMarker(stateRoot: string, marker: Parameters<typeof writeRunningMarker>[1]) {
  mkdirSync(stateRoot, { recursive: true });
  writeRunningMarker(stateRoot, marker, () => {});
}

describe("squadrantd boot-gap detection (#589)", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("logs 'previous exit: none' on a first boot with no marker present", () => {
    dir = mkdtempSync(join(tmpdir(), "boot-gap-"));
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let handle: ReturnType<typeof startSquadrantd> | undefined;
    try {
      handle = startSquadrantd({ stateRoot: join(dir, "state"), sockPath: join(dir, "c.sock"), sweepMs: 0 });
      const lines = writeSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("previous exit: none (clean or first boot)"))).toBe(true);
    } finally {
      writeSpy.mockRestore();
      handle?.stop();
    }
  });

  it("logs the gap when a previous exit marker is present, and consumes (deletes) it", () => {
    dir = mkdtempSync(join(tmpdir(), "boot-gap-"));
    const stateRoot = join(dir, "state");
    const oldTs = new Date(Date.now() - 5_000).toISOString();
    seedMarker(stateRoot, {
      ts: oldTs, pid: 999, reason: "SIGTERM", ppid: 1, uptimeMs: 42_000, inFlightDelivery: null,
    });

    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let handle: ReturnType<typeof startSquadrantd> | undefined;
    try {
      handle = startSquadrantd({ stateRoot, sockPath: join(dir, "c.sock"), sweepMs: 0 });
      const lines = writeSpy.mock.calls.map((c) => String(c[0]));
      const gapLine = lines.find((l) => l.includes("previous exit ts=") && l.includes("reason=SIGTERM"));
      expect(gapLine).toBeDefined();
      expect(gapLine).toMatch(/gap=\d+(\.\d+)?s/);
      // Consumed by THIS boot — checked directly rather than via a second
      // startSquadrantd(), since handle.stop() below would itself write a
      // fresh marker and confound a second-boot read.
      expect(existsSync(exitMarkerPath(stateRoot))).toBe(false);
    } finally {
      writeSpy.mockRestore();
      handle?.stop();
    }
  });

  it("posts a captain.message alert to registered projects when the gap exceeds 60s", async () => {
    dir = mkdtempSync(join(tmpdir(), "boot-gap-"));
    const stateRoot = join(dir, "state");
    const oldTs = new Date(Date.now() - 25 * 60_000).toISOString(); // 25 min ago
    seedMarker(stateRoot, {
      ts: oldTs, pid: 999, reason: "SIGTERM", ppid: 1, uptimeMs: 100, inFlightDelivery: null,
    });

    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let handle: ReturnType<typeof startSquadrantd> | undefined;
    try {
      handle = startSquadrantd({
        stateRoot, sockPath: join(dir, "c.sock"), sweepMs: 0,
        registeredProjects: ["demo"],
      });
      // Boot-gap alert append is fire-and-forget from squadrantd's perspective —
      // give the microtask queue a turn to flush the mailbox write.
      await new Promise((r) => setTimeout(r, 20));

      const texts: string[] = [];
      for await (const entry of readFromCursor({ stateRoot, project: "demo", fromSeq: 1 })) {
        if (entry.message) texts.push(entry.message);
      }
      const alert = texts.find((t) => t.includes("daemon was down"));
      expect(alert).toBeDefined();
      // #744: the window (not just a bare minute count) must be baked in —
      // a "→" between the local start/end timestamps, plus the tz offset.
      expect(alert).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} → \d{4}-\d{2}-\d{2} \d{2}:\d{2} \([+-]\d{2}(:\d{2})?\)/);
      expect(alert).toContain("25 min");
      expect(alert).toContain("reason=SIGTERM");
    } finally {
      writeSpy.mockRestore();
      handle?.stop();
    }
  });

  it("does NOT alert when the gap is under 60s (a quick bounce is not an outage)", async () => {
    dir = mkdtempSync(join(tmpdir(), "boot-gap-"));
    const stateRoot = join(dir, "state");
    const oldTs = new Date(Date.now() - 5_000).toISOString(); // 5s ago
    seedMarker(stateRoot, {
      ts: oldTs, pid: 999, reason: "requested", ppid: 1, uptimeMs: 100, inFlightDelivery: null,
    });

    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let handle: ReturnType<typeof startSquadrantd> | undefined;
    try {
      handle = startSquadrantd({
        stateRoot, sockPath: join(dir, "c.sock"), sweepMs: 0,
        registeredProjects: ["demo"],
      });
      await new Promise((r) => setTimeout(r, 20));

      const texts: string[] = [];
      for await (const entry of readFromCursor({ stateRoot, project: "demo", fromSeq: 1 })) {
        if (entry.message) texts.push(entry.message);
      }
      expect(texts.some((t) => t.includes("daemon was down"))).toBe(false);
    } finally {
      writeSpy.mockRestore();
      handle?.stop();
    }
  });
});

// #589 gap: a SIGKILL/OOM-kill/power-loss never runs the shutdown JS that
// writes an exit marker, so without more, that death reads as "previous
// exit: none" — indistinguishable from a genuine first boot. The running
// marker (heartbeat, written at boot / touched every rotation tick / removed
// on graceful stop) closes that gap.
describe("squadrantd unclean-death detection via the running marker (#589)", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("logs UNCLEAN and alerts when a running marker survives with no exit marker to explain it", async () => {
    dir = mkdtempSync(join(tmpdir(), "boot-gap-unclean-"));
    const stateRoot = join(dir, "state");
    const oldHeartbeat = new Date(Date.now() - 25 * 60_000).toISOString(); // 25 min ago
    seedRunningMarker(stateRoot, { pid: 4242, bootTs: oldHeartbeat, lastHeartbeatTs: oldHeartbeat });

    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let handle: ReturnType<typeof startSquadrantd> | undefined;
    try {
      handle = startSquadrantd({
        stateRoot, sockPath: join(dir, "c.sock"), sweepMs: 0,
        registeredProjects: ["demo"],
      });
      const lines = writeSpy.mock.calls.map((c) => String(c[0]));
      const uncleanLine = lines.find((l) => l.includes("previous exit: UNCLEAN"));
      expect(uncleanLine).toBeDefined();
      expect(uncleanLine).toContain("no marker");
      expect(uncleanLine).toMatch(/gap=\d+(\.\d+)?s/);

      await new Promise((r) => setTimeout(r, 20));
      const texts: string[] = [];
      for await (const entry of readFromCursor({ stateRoot, project: "demo", fromSeq: 1 })) {
        if (entry.message) texts.push(entry.message);
      }
      const alert = texts.find((t) => t.includes("daemon was down"));
      expect(alert).toBeDefined();
      expect(alert).toContain("25 min");
      expect(alert).toMatch(/SIGKILL|OOM|power-loss/);
    } finally {
      writeSpy.mockRestore();
      handle?.stop();
    }
  });

  it("does NOT report UNCLEAN when a stale running marker coexists with a real exit marker — the exit marker wins", () => {
    dir = mkdtempSync(join(tmpdir(), "boot-gap-unclean-"));
    const stateRoot = join(dir, "state");
    const oldTs = new Date(Date.now() - 5_000).toISOString();
    seedMarker(stateRoot, { ts: oldTs, pid: 999, reason: "SIGTERM", ppid: 1, uptimeMs: 100, inFlightDelivery: null });
    seedRunningMarker(stateRoot, { pid: 999, bootTs: oldTs, lastHeartbeatTs: oldTs });

    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let handle: ReturnType<typeof startSquadrantd> | undefined;
    try {
      handle = startSquadrantd({ stateRoot, sockPath: join(dir, "c.sock"), sweepMs: 0 });
      const lines = writeSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("previous exit ts=") && l.includes("reason=SIGTERM"))).toBe(true);
      expect(lines.some((l) => l.includes("UNCLEAN"))).toBe(false);
    } finally {
      writeSpy.mockRestore();
      handle?.stop();
    }
  });

  it("writes a fresh running marker at boot, and removes it on graceful stop()", async () => {
    dir = mkdtempSync(join(tmpdir(), "boot-gap-unclean-"));
    const stateRoot = join(dir, "state");
    const handle = startSquadrantd({ stateRoot, sockPath: join(dir, "c.sock"), sweepMs: 0 });
    try {
      const running = readRunningMarker(stateRoot);
      expect(running).not.toBeNull();
      expect(running!.pid).toBe(process.pid);
    } finally {
      await handle.stop();
    }
    expect(existsSync(runningMarkerPath(stateRoot))).toBe(false);
  });

  it("touches (refreshes) the running marker's heartbeat via the rotation tick, without changing pid/bootTs", async () => {
    dir = mkdtempSync(join(tmpdir(), "boot-gap-unclean-"));
    const stateRoot = join(dir, "state");
    vi.useFakeTimers();
    let handle: ReturnType<typeof startSquadrantd> | undefined;
    try {
      handle = startSquadrantd({ stateRoot, sockPath: join(dir, "c.sock"), sweepMs: 0, rotationIntervalMs: 60_000 });
      const atBoot = readRunningMarker(stateRoot)!;

      await vi.advanceTimersByTimeAsync(1_000);
      await handle.tickRotation!();

      const afterTick = readRunningMarker(stateRoot)!;
      expect(afterTick.pid).toBe(atBoot.pid);
      expect(afterTick.bootTs).toBe(atBoot.bootTs);
      expect(new Date(afterTick.lastHeartbeatTs).getTime()).toBeGreaterThan(new Date(atBoot.lastHeartbeatTs).getTime());
    } finally {
      vi.useRealTimers();
      handle?.stop();
    }
  });
});
