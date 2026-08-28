// #589: the exit marker is what makes a daemon death diagnosable across a
// restart — written just before shutdown, read back (and cleared) on the
// next boot.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeExitMarker, consumeExitMarker, exitMarkerPath, type ExitMarker,
  writeRunningMarker, readRunningMarker, removeRunningMarker, runningMarkerPath, type RunningMarker,
} from "../exit-marker.js";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "exit-marker-"));
}

describe("writeExitMarker / consumeExitMarker (#589)", () => {
  it("writes a marker readable by consumeExitMarker, carrying pid/reason/ppid/uptimeMs/inFlightDelivery", () => {
    const stateRoot = freshState();
    const marker: ExitMarker = {
      ts: new Date(1000).toISOString(),
      pid: 4242,
      reason: "SIGTERM",
      ppid: 1,
      uptimeMs: 12345,
      inFlightDelivery: { project: "demo", seq: 7, deferCount: 300 },
    };
    writeExitMarker(stateRoot, marker, () => {});
    expect(existsSync(exitMarkerPath(stateRoot))).toBe(true);

    const { marker: read, gapMs } = consumeExitMarker(stateRoot, () => 1000 + 90_000);
    expect(read).toEqual(marker);
    expect(gapMs).toBe(90_000);
  });

  it("deletes the marker after consuming it — a marker only describes the ONE preceding exit", () => {
    const stateRoot = freshState();
    writeExitMarker(stateRoot, {
      ts: new Date().toISOString(), pid: 1, reason: "requested", ppid: 1,
      uptimeMs: 0, inFlightDelivery: null,
    }, () => {});
    consumeExitMarker(stateRoot);
    expect(existsSync(exitMarkerPath(stateRoot))).toBe(false);
    // A second read (simulating the NEXT boot after a clean run with no new exit) finds nothing.
    const second = consumeExitMarker(stateRoot);
    expect(second.marker).toBeNull();
    expect(second.gapMs).toBeUndefined();
  });

  it("reports no marker when none was ever written (first boot / marker already consumed)", () => {
    const stateRoot = freshState();
    const { marker, gapMs } = consumeExitMarker(stateRoot);
    expect(marker).toBeNull();
    expect(gapMs).toBeUndefined();
  });

  it("treats a corrupt marker file as absent rather than throwing", () => {
    const stateRoot = freshState();
    writeFileSync(exitMarkerPath(stateRoot), "{ not valid json");
    const { marker } = consumeExitMarker(stateRoot);
    expect(marker).toBeNull();
    // Still cleaned up so a corrupt marker doesn't wedge every future boot.
    expect(existsSync(exitMarkerPath(stateRoot))).toBe(false);
  });

  it("write is best-effort — an unwritable path logs instead of throwing", () => {
    const logs: string[] = [];
    // A path under a file (not a directory) can never be written to.
    const stateRoot = join(freshState(), "not-a-dir-because-no-mkdir");
    writeExitMarker(join(stateRoot, "nested", "deeper"), {
      ts: new Date().toISOString(), pid: 1, reason: "requested", ppid: 1,
      uptimeMs: 0, inFlightDelivery: null,
    }, (m) => logs.push(m));
    expect(logs.some((l) => l.includes("exit marker write failed"))).toBe(true);
  });

  it("computes gapMs as elapsed time since the marker's ts, clamped to >= 0", () => {
    const stateRoot = freshState();
    writeExitMarker(stateRoot, {
      ts: new Date(5000).toISOString(), pid: 1, reason: "requested", ppid: 1,
      uptimeMs: 0, inFlightDelivery: null,
    }, () => {});
    // "now" earlier than the marker's ts (clock skew) must not go negative.
    const { gapMs } = consumeExitMarker(stateRoot, () => 1000);
    expect(gapMs).toBe(0);
  });
});

// #589 gap: the exit marker above is only ever written by JS running on the
// way out — a SIGKILL, OOM kill, or power loss runs none of it, so the
// daemon can die leaving NO exit marker at all, indistinguishable from a
// genuine first boot. The running marker closes that gap.
describe("writeRunningMarker / readRunningMarker / removeRunningMarker (#589 unclean-death detection)", () => {
  it("writes a marker readable back by readRunningMarker", () => {
    const stateRoot = freshState();
    const marker: RunningMarker = { pid: 555, bootTs: new Date(1000).toISOString(), lastHeartbeatTs: new Date(2000).toISOString() };
    writeRunningMarker(stateRoot, marker, () => {});
    expect(existsSync(runningMarkerPath(stateRoot))).toBe(true);
    expect(readRunningMarker(stateRoot)).toEqual(marker);
  });

  it("returns null when no running marker was ever written", () => {
    const stateRoot = freshState();
    expect(readRunningMarker(stateRoot)).toBeNull();
  });

  it("treats a corrupt running marker as absent rather than throwing", () => {
    const stateRoot = freshState();
    writeFileSync(runningMarkerPath(stateRoot), "{ not valid json");
    expect(readRunningMarker(stateRoot)).toBeNull();
  });

  it("does NOT delete the marker on read — the caller overwrites it unconditionally for the new boot", () => {
    const stateRoot = freshState();
    const marker: RunningMarker = { pid: 1, bootTs: "t", lastHeartbeatTs: "t" };
    writeRunningMarker(stateRoot, marker, () => {});
    readRunningMarker(stateRoot);
    expect(existsSync(runningMarkerPath(stateRoot))).toBe(true);
  });

  it("removeRunningMarker deletes it, and is a silent no-op when already absent", () => {
    const stateRoot = freshState();
    writeRunningMarker(stateRoot, { pid: 1, bootTs: "t", lastHeartbeatTs: "t" }, () => {});
    const logs: string[] = [];
    removeRunningMarker(stateRoot, (m) => logs.push(m));
    expect(existsSync(runningMarkerPath(stateRoot))).toBe(false);
    // Calling it again (nothing to remove) must not log an error (ENOENT is expected, not a failure).
    removeRunningMarker(stateRoot, (m) => logs.push(m));
    expect(logs).toEqual([]);
  });

  it("write is best-effort — an unwritable path logs instead of throwing", () => {
    const logs: string[] = [];
    const stateRoot = join(freshState(), "not-a-dir-because-no-mkdir");
    writeRunningMarker(join(stateRoot, "nested", "deeper"), { pid: 1, bootTs: "t", lastHeartbeatTs: "t" }, (m) => logs.push(m));
    expect(logs.some((l) => l.includes("running marker write failed"))).toBe(true);
  });
});
