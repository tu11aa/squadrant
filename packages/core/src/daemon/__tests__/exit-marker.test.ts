// #589: the exit marker is what makes a daemon death diagnosable across a
// restart — written just before shutdown, read back (and cleared) on the
// next boot.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeExitMarker, consumeExitMarker, exitMarkerPath, type ExitMarker } from "../exit-marker.js";

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
