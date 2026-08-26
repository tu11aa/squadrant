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
