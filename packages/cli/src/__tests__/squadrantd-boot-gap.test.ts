// #589: on boot, the daemon reads back the previous exit marker (if any) and
// surfaces the gap between that exit and now — a restart's cause and the
// awake-time gap must never be silent. Complements squadrantd-boot-marker.test.ts
// (which covers the marker being WRITTEN on stop()).
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeExitMarker, readFromCursor, exitMarkerPath } from "@squadrant/core";
import { startSquadrantd } from "../squadrantd.js";

/** A marker written by a PRIOR daemon session already implies its stateRoot
 *  existed — mkdir it first, mirroring what buildContext() does on every real
 *  boot, so writeExitMarker isn't silently dropped by a missing directory. */
function seedMarker(stateRoot: string, marker: Parameters<typeof writeExitMarker>[1]) {
  mkdirSync(stateRoot, { recursive: true });
  writeExitMarker(stateRoot, marker, () => {});
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
      const alert = texts.find((t) => t.includes("daemon was down for"));
      expect(alert).toBeDefined();
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
      expect(texts.some((t) => t.includes("daemon was down for"))).toBe(false);
    } finally {
      writeSpy.mockRestore();
      handle?.stop();
    }
  });
});
