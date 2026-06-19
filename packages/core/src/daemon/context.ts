// src/control/daemon/context.ts
// CockpitdOpts, defaultIsPidAlive, DaemonContext, and buildContext.
// Kept here (not in cockpitd.ts) so daemon/* modules can import this file
// without creating a circular dependency on the host entrypoint.
// cockpitd.ts re-exports CockpitdOpts and defaultIsPidAlive for backward compat.
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn as realSpawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createStore } from "../store.js";
import { createDaemon } from "../daemon.js";
import { loadConfig } from "@cockpit/shared";
import type { TaskRecord, ControlEvent, Gate, AutoConfigResult } from "@cockpit/shared";
import type { Socket } from "node:net";
import type { PaneRef } from "@cockpit/shared";
import type { AgentDriver, OpencodeBridge, CmuxEventsBridge, DaemonSurfaceDriver } from "../interfaces.js";
import type { AttachFrame } from "../protocol.js";

// ── Public injectable options (equivalent of old cockpitd.ts CockpitdOpts) ───

export interface CockpitdOpts {
  stateRoot?: string;
  sockPath?: string;
  sweepMs?: number; // 0 disables the interval (tests)
  isPidAlive?: (pid: number) => boolean;
  isSurfaceAlive?: (rec: TaskRecord) => Promise<"alive" | "gone" | "unknown">;
  spawn?: typeof realSpawn;
  /**
   * Push-notification hook (#109). Defaults to appending a structured event
   * to the mailbox file at <stateRoot>/inbox/<project>.log; an injector
   * process inside the captain workspace tails the file and delivers entries
   * to the captain pane. Tests inject a fake to assert call shape.
   */
  notify?: (args: {
    project: string;
    message: string;
    record: TaskRecord;
    event: ControlEvent;
  }) => Promise<void> | void;
  /** Background rotation timer interval (ms). 0 disables. Default 60_000. */
  rotationIntervalMs?: number;
  /** Mailbox rotation thresholds (size/age/retention). */
  mailboxConfig?: {
    maxBytes?: number;
    maxAgeMs?: number;
    keepCount?: number;
  };
  /** Inject a fake driver for tests. Defaults to a real CodexInteractiveDriver. */
  codexDriver?: AgentDriver;
  /** Inject a fake headless launcher for tests to avoid real process spawns. */
  launchHeadless?: (rec: TaskRecord) => Promise<void>;
  /** Override which projects appear in the Tier 2 per-project snapshot. */
  registeredProjects?: string[];
  /** Inject a fake opencode SSE bridge for tests. */
  opencodeBridge?: OpencodeBridge;
  /** B1: inject a fake cmux events bridge for tests. */
  cmuxEventsBridge?: CmuxEventsBridge;
  /** Inject a fake surface driver for testing daemon-direct delivery. */
  daemonCmux?: DaemonSurfaceDriver;
  /** Factory for constructing the surface driver in production. */
  makeDaemonCmux?: () => DaemonSurfaceDriver;
  /** Injected captain-surface mapping (project → PaneRef) for tests. */
  captainSurfaces?: Record<string, PaneRef>;
  /** #348: override the cmux socket auto-config re-check. */
  runCmuxAutoConfig?: () => Promise<AutoConfigResult>;
}

export function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === "EPERM"; } // EPERM = alive but not ours; ESRCH = dead
}

// ── Shared state bag ──────────────────────────────────────────────────────────

/** All shared mutable state for the running daemon. Most fields are set in
 *  buildContext; late-bound fields (d, notify, broadcast, etc.) are assigned
 *  by start.ts after building the daemon and factories, before any event fires. */
export interface DaemonContext {
  opts: CockpitdOpts;
  stateRoot: string;
  sockPath: string;
  store: ReturnType<typeof createStore>;
  bootedAt: number;
  /** Mutable box so sweep timer can update lastSweepAt without a closure rebind. */
  lastSweepAt: { value: number | null };
  taskTimeoutMs: number | undefined;
  isPidAlive: (pid: number) => boolean;
  spawn: typeof realSpawn;
  resultsDir: string;
  writeResult: (id: string, payload: string) => string;
  log: (m: string) => void;
  /** Per-task live attach connections (spec §4.5/§4.6). */
  attachConns: Map<string, Set<Socket>>;
  /** Tasks being launched headlessly with no pid yet (#259). */
  inFlightHeadlessIds: Set<string>;
  /** Cancel handles for in-flight headless runs. */
  activeHeadlessKills: Set<() => void>;
  /** #332 delivery streak counter per project for captain-absent reaping. */
  captainMissingStreak: Map<string, number>;
  /** #332 projects whose captain surface is confirmed gone. */
  stoppedProjects: Set<string>;

  // ── Late-bound: assigned by start.ts before any timer/server fires ──────────

  /** Resolved daemon instance. */
  d: ReturnType<typeof createDaemon>;
  /** Resolved notify function. */
  notify: (args: { project: string; message: string; record: TaskRecord; event: ControlEvent }) => Promise<void> | void;
  /** Resolved surface driver for daemon-direct delivery. */
  daemonCmux: DaemonSurfaceDriver | undefined;
  /** Resolved agent driver. */
  codexDriver: AgentDriver;
  /** Resolved opencode SSE bridge. */
  opencodeBridge: OpencodeBridge;
  /** Resolved cmux events bridge. */
  cmuxEventsBridge: CmuxEventsBridge;
  /** Fan-out to attach clients (set by createAttach). */
  broadcast: (taskId: string, f: AttachFrame) => void;
  /** Schedule gate promotion (set by createAttach). */
  schedulePromotion: (taskId: string, requestId: number, kind: "input" | "approval", question: string) => void;
  /** Cancel gate timers for a task (set by createAttach). */
  cancelPromotionsFor: (taskId: string) => void;
}

/** Initialize the pure-state fields of DaemonContext from opts.
 *  Late-bound fields are zero-initialized and MUST be set by start.ts
 *  (or cockpitd.ts for drivers) before any event, timer, or socket fires. */
export function buildContext(opts: CockpitdOpts): DaemonContext {
  const stateRoot = opts.stateRoot ?? join(homedir(), ".config", "cockpit", "state");
  const sockPath = opts.sockPath ?? join(homedir(), ".config", "cockpit", "cockpit.sock");
  const store = createStore(stateRoot);
  const bootedAt = Date.now();
  const taskTimeoutMs = loadConfig().defaults.taskTimeoutMs;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const spawn = opts.spawn ?? realSpawn;
  const resultsDir = join(stateRoot, "_results");
  mkdirSync(resultsDir, { recursive: true });
  const writeResult = (id: string, payload: string) => {
    const p = join(resultsDir, `${id}.txt`);
    writeFileSync(p, payload);
    return p;
  };
  const log = (m: string) =>
    process.stderr.write(`[cockpitd] ${new Date().toISOString()} ${m}\n`);

  return {
    opts,
    stateRoot,
    sockPath,
    store,
    bootedAt,
    lastSweepAt: { value: null },
    taskTimeoutMs,
    isPidAlive,
    spawn,
    resultsDir,
    writeResult,
    log,
    attachConns: new Map(),
    inFlightHeadlessIds: new Set(),
    activeHeadlessKills: new Set(),
    captainMissingStreak: new Map(),
    stoppedProjects: new Set(),
    // Late-bound — start.ts fills these before first use:
    d: null as unknown as ReturnType<typeof createDaemon>,
    notify: null as unknown as DaemonContext["notify"],
    daemonCmux: undefined,
    codexDriver: null as unknown as AgentDriver,
    opencodeBridge: null as unknown as OpencodeBridge,
    cmuxEventsBridge: null as unknown as CmuxEventsBridge,
    broadcast: () => {},
    schedulePromotion: () => {},
    cancelPromotionsFor: () => {},
  };
}
