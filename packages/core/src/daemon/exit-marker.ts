// src/daemon/exit-marker.ts
// #589: a small on-disk marker written just before shutdown and read back on
// the next boot, so a restart's cause and the awake-time gap are diagnosable
// from evidence instead of inferred from process start time (see the
// existing #535 boot/exit log lines in start.ts, which this extends).
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ExitMarker {
  ts: string;
  pid: number;
  reason: string;
  ppid: number;
  uptimeMs: number;
  inFlightDelivery: { project: string; seq: number; deferCount: number } | null;
}

export function exitMarkerPath(stateRoot: string): string {
  return join(stateRoot, "exit-marker.json");
}

/** Best-effort, synchronous — called from the shutdown path before any async
 *  teardown, so it lands even if the caller doesn't await stop() (mirrors the
 *  #535 exit log line's own synchronous-write guarantee). Never throws. */
export function writeExitMarker(stateRoot: string, marker: ExitMarker, log: (m: string) => void): void {
  try {
    writeFileSync(exitMarkerPath(stateRoot), JSON.stringify(marker));
  } catch (e) {
    log(`exit marker write failed: ${(e as Error).message}`);
  }
}

export interface BootGapReport {
  marker: ExitMarker | null;
  /** ms between the marker's ts and now. Present iff marker is present. */
  gapMs?: number;
}

/** Read the previous exit marker, if any, and delete it — a marker only
 *  describes the exit immediately preceding THIS boot; leaving it on disk
 *  would misattribute a later crash's gap to a stale earlier exit. Corrupt or
 *  unreadable markers are treated as absent (never throws, never blocks boot). */
export function consumeExitMarker(stateRoot: string, now: () => number = Date.now): BootGapReport {
  const p = exitMarkerPath(stateRoot);
  if (!existsSync(p)) return { marker: null };
  let marker: ExitMarker | null = null;
  try {
    marker = JSON.parse(readFileSync(p, "utf-8")) as ExitMarker;
  } catch {
    marker = null;
  }
  try { unlinkSync(p); } catch { /* best-effort */ }
  if (!marker) return { marker: null };
  const gapMs = Math.max(0, now() - new Date(marker.ts).getTime());
  return { marker, gapMs };
}

/**
 * #589 gap: an exit marker only ever gets written by JS running on the way
 * out (stop(), or the uncaughtException/unhandledRejection crash handler) —
 * a SIGKILL, an OOM kill, or a power loss runs none of that, so the daemon
 * can die with NO exit marker at all. Without more, that's indistinguishable
 * from a genuine first boot ("previous exit: none"), which is exactly the
 * silent case #589 is about.
 *
 * The running marker closes that gap: written at boot and re-touched
 * periodically (~60s) as a heartbeat, then explicitly removed on a graceful
 * stop(). If it's still on disk on the NEXT boot with no exit marker to
 * explain it, the only daemon that could have written it never got to run
 * any shutdown code — an unclean death.
 */
export interface RunningMarker {
  pid: number;
  bootTs: string;
  lastHeartbeatTs: string;
}

export function runningMarkerPath(stateRoot: string): string {
  return join(stateRoot, "running-marker.json");
}

/** Best-effort, synchronous. Called once at boot (fresh pid/bootTs) and again
 *  on every heartbeat tick (same pid/bootTs, refreshed lastHeartbeatTs). */
export function writeRunningMarker(stateRoot: string, marker: RunningMarker, log: (m: string) => void): void {
  try {
    writeFileSync(runningMarkerPath(stateRoot), JSON.stringify(marker));
  } catch (e) {
    log(`running marker write failed: ${(e as Error).message}`);
  }
}

/** Read the running marker left by a PRIOR boot, if any. Does not delete it —
 *  the caller overwrites it unconditionally with a fresh one for this boot
 *  right after deciding what the read told them. Corrupt/missing → null. */
export function readRunningMarker(stateRoot: string): RunningMarker | null {
  try {
    return JSON.parse(readFileSync(runningMarkerPath(stateRoot), "utf-8")) as RunningMarker;
  } catch {
    return null;
  }
}

/** Best-effort. Called on graceful stop() — its absence (together with the
 *  fresh exit marker stop() also writes) is what marks a shutdown as
 *  diagnosed/clean on the next boot, rather than unclean. */
export function removeRunningMarker(stateRoot: string, log: (m: string) => void): void {
  try {
    unlinkSync(runningMarkerPath(stateRoot));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`running marker remove failed: ${(e as Error).message}`);
  }
}
