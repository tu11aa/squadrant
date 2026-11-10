// #1112 P0: machine-suspension clock. Wall-clock budgets (task ceiling, stall,
// quiet, re-nudge, first-turn resend) used to keep counting while the laptop was
// asleep. This module detects a suspension (tick gap + OS confirmation), persists
// the last 48h, and answers `awakeElapsed(from, to)` = wall time minus suspensions.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Suspension {
  from: number;
  to: number;
  kind: "sleep" | "daemon-down";
}

/** A tick gap larger than (tick interval + this) is a suspension candidate. */
export const DEFAULT_TICK_GAP_MS = 30_000;
/** After a suspension ends, timer-based actions stay paused this long. */
export const DEFAULT_POST_WAKE_GRACE_MS = 120_000;
/** Suspensions older than this are dropped from the persisted log. */
export const SUSPENSION_RETENTION_MS = 48 * 60 * 60 * 1000;
/** Detector heartbeat cadence (also driven from the sweep tick). */
export const SUSPENSION_TICK_MS = 5_000;

/** Pure. Wall time between `from` and `to` minus the overlap with `suspensions`. */
export function awakeElapsedMs(suspensions: readonly Suspension[], from: number, to: number): number {
  if (to <= from) return 0;
  let asleep = 0;
  for (const s of suspensions) {
    const lo = Math.max(from, s.from);
    const hi = Math.min(to, s.to);
    if (hi > lo) asleep += hi - lo;
  }
  return to - from - asleep;
}

export interface SleepWake { sleepMs: number; wakeMs: number }

const SYSCTL_RE = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/;

/** Parses `sysctl -n kern.sleeptime kern.waketime` output (two lines). */
export function parseSleepWake(out: string): SleepWake | null {
  const m = out.split(/\r?\n/).map((l) => SYSCTL_RE.exec(l)).filter((x): x is RegExpExecArray => !!x);
  if (m.length < 2) return null;
  const ms = (x: RegExpExecArray) => Number(x[1]) * 1000 + Math.floor(Number(x[2]) / 1000);
  return { sleepMs: ms(m[0]), wakeMs: ms(m[1]) };
}

/** Real OS probe. macOS only; null elsewhere or on any failure. Bounded to 1s. */
export function readOsSleepWake(): SleepWake | null {
  if (process.platform !== "darwin") return null;
  try {
    return parseSleepWake(execFileSync("sysctl", ["-n", "kern.sleeptime", "kern.waketime"], { timeout: 1000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch { return null; }
}

export interface SuspensionClockOpts {
  /** Persist path; omit for in-memory only. */
  path?: string;
  now?: () => number;
  log?: (m: string) => void;
  /** Detector heartbeat interval, used for the gap threshold. */
  intervalMs?: number;
  tickGapMs?: number;
  postWakeGraceMs?: number;
  /** Injectable for tests. */
  readOs?: () => SleepWake | null;
}

export interface SuspensionClock {
  /** Run gap detection. Cheap; call from every timer that drives timed actions. */
  tick(): void;
  awakeElapsed(from: number, to: number): number;
  /** True during the post-wake grace window after a suspension. */
  paused(at?: number): boolean;
  /** Record the daemon's own downtime/sleep between a previous heartbeat and this boot. */
  recordBootGap(from: number, to: number): void;
  list(): Suspension[];
}

export function createSuspensionClock(opts: SuspensionClockOpts = {}): SuspensionClock {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const intervalMs = opts.intervalMs ?? SUSPENSION_TICK_MS;
  const tickGapMs = opts.tickGapMs ?? DEFAULT_TICK_GAP_MS;
  const graceMs = opts.postWakeGraceMs ?? DEFAULT_POST_WAKE_GRACE_MS;
  const readOs = opts.readOs ?? readOsSleepWake;
  let list: Suspension[] = [];
  let lastTick = now();

  if (opts.path) {
    try {
      const raw = JSON.parse(readFileSync(opts.path, "utf8")) as { suspensions?: Suspension[] };
      list = (raw.suspensions ?? []).filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to));
    } catch { /* missing or corrupt: start empty */ }
  }

  function persist(): void {
    if (!opts.path) return;
    try {
      mkdirSync(dirname(opts.path), { recursive: true });
      writeFileSync(`${opts.path}.tmp`, JSON.stringify({ schema: 1, suspensions: list }));
      renameSync(`${opts.path}.tmp`, opts.path);
    } catch (e) { log(`suspensions persist failed: ${(e as Error).message}`); }
  }

  function add(s: Suspension): void {
    // Dark wakes make a night of many short gaps: merge ones that touch/overlap so the log stays small.
    const last = list[list.length - 1];
    if (last && last.kind === s.kind && s.from <= last.to) list[list.length - 1] = { ...last, to: Math.max(last.to, s.to) };
    else list.push(s);
    const cutoff = now() - SUSPENSION_RETENTION_MS;
    list = list.filter((x) => x.to >= cutoff);
    persist();
  }

  // Sleep is confirmed when the OS's last sleep time falls inside the gap. Dark
  // wakes are included in kern.sleeptime/waketime. No OS answer (non-macOS or a
  // failed read) degrades to the tick gap alone.
  function confirmed(from: number, to: number): boolean {
    const os = readOs();
    if (!os) return true;
    return os.sleepMs >= from - 5_000 && os.sleepMs <= to;
  }

  return {
    tick() {
      const t = now();
      const gap = t - lastTick;
      const from = lastTick;
      lastTick = t;
      if (gap < 0) return; // clock set backwards
      if (gap <= intervalMs + tickGapMs) return;
      if (!confirmed(from, t)) {
        log(`event-loop stall ${Math.round(gap / 1000)}s (no OS sleep in window) — timers not paused`);
        return;
      }
      add({ from, to: t, kind: "sleep" });
      log(`suspension ${new Date(from).toISOString()} -> ${new Date(t).toISOString()} (${Math.round(gap / 1000)}s)`);
    },
    awakeElapsed: (from, to) => awakeElapsedMs(list, from, to),
    paused(at = now()) {
      const last = list[list.length - 1];
      return !!last && at >= last.to && at - last.to < graceMs;
    },
    recordBootGap(from, to) {
      if (to - from <= intervalMs + tickGapMs) return;
      const os = readOs();
      add({ from, to, kind: os && os.sleepMs >= from - 5_000 && os.sleepMs <= to ? "sleep" : "daemon-down" });
      lastTick = now();
    },
    list: () => [...list],
  };
}

export function suspensionsPath(stateRoot: string): string {
  return join(stateRoot, "status", "suspensions.json");
}
