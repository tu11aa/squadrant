// cmux-store-source.ts — LifecycleSource adapter for ~/.cmuxterm/*-hook-sessions.json
//
// Implements the backup LifecycleSource (D1: A-backup) from the #333 design.
// Watches the cmux state directory, reads each agent's hook-sessions.json, and
// feeds LifecycleSnapshots into the reduceLifecycle pipeline via deps.report().
//
// NOT wired into the live daemon path in Phase 1 (additive per D3/D7).
//
// CORRELATION CONSTRAINT (research §2.2): launchCommand in the store has no
// environment vars — SQUADRANT_CREW_TASK_ID is not available. Correlate by:
//   1. cwd (primary for interactive crews — match against TaskRecord.cwd)
//   2. pid (passed in hint; daemon can try KERN_PROCARGS2 lookup later)
//   3. sessionId (cmux UUID; may match TaskRecord.sessionId if crew populates it)
import { join } from "node:path";
import { homedir } from "node:os";
import { watch, readdirSync, readFileSync, existsSync } from "node:fs";
import type { LifecycleSource, LifecycleSourceDeps, LifecycleSnapshot, CorrelationHint, LifecycleState } from "@squadrant/core";

// ── store file schema (version:1, live schema from research report §2.2) ─────

interface StoreSession {
  sessionId: string;
  agentLifecycle: string;
  pid: number;
  cwd: string;
  lastBody?: string;
  isRestorable?: boolean;
  updatedAt: number;  // Unix float (seconds)
}

interface StoreFile {
  sessions?: Record<string, StoreSession>;
}

// ── injectable deps ──────────────────────────────────────────────────────────

export interface CmuxStoreSourceOpts {
  /** Directory to watch. Defaults to CMUX_AGENT_HOOK_STATE_DIR or ~/.cmuxterm. */
  stateDir?: string;
  /** Debounce delay between a watch event and the next scan (ms). Default 50. */
  debounceMs?: number;
  /** Returns true if the given pid is alive. Default: process.kill(pid, 0). */
  isPidAlive?: (pid: number) => boolean;
  /**
   * Lists store files in the given directory.
   * Default: readdirSync filtered to *-hook-sessions.json.
   */
  listFiles?: (dir: string) => string[];
  /**
   * Reads a file's content, returns undefined on any read error.
   * Default: readFileSync.
   */
  readFile?: (path: string) => string | undefined;
  /**
   * Returns true if the given path exists (lock-file check).
   * Default: existsSync.
   */
  fileExists?: (path: string) => boolean;
  /**
   * Starts a directory watcher. Calls cb on relevant file changes.
   * Returns a stop function. Default: fs.watch.
   */
  watchDir?: (dir: string, cb: () => void) => () => void;
  /** Injectable setTimeout for debouncing. Default: global setTimeout. */
  scheduleTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Injectable clearTimeout for debouncing. Default: global clearTimeout. */
  cancelTimer?: (id: ReturnType<typeof setTimeout>) => void;
  log?: (msg: string) => void;
}

// ── CmuxStoreSource ──────────────────────────────────────────────────────────

/**
 * LifecycleSource that watches ~/.cmuxterm/*-hook-sessions.json.
 *
 * cmux writes the hook-sessions file on every lifecycle-changing hook event
 * (SessionStart, UserPromptSubmit, PreToolUse, Stop, Notification, AskUserQuestion).
 * Each session record carries `agentLifecycle` in the 4-state vocabulary that
 * exactly matches LifecycleState, so no re-mapping is needed.
 *
 * Events carry origin:"agent" because the store is the agent's own reported
 * lifecycle state — not inferred from a process scan.
 */
export class CmuxStoreSource implements LifecycleSource {
  readonly name = "cmux-store";

  private readonly stateDir: string;
  private readonly debounceMs: number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly listFiles: (dir: string) => string[];
  private readonly readFile: (path: string) => string | undefined;
  private readonly fileExists: (path: string) => boolean;
  private readonly watchDir: (dir: string, cb: () => void) => () => void;
  private readonly scheduleTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly cancelTimer: (id: ReturnType<typeof setTimeout>) => void;
  private readonly log: (msg: string) => void;

  private deps?: LifecycleSourceDeps;
  private stopWatcher?: () => void;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  /** taskId → last reported snapshot (for snapshot() liveness floor). */
  private cache = new Map<string, LifecycleSnapshot>();

  constructor(opts: CmuxStoreSourceOpts = {}) {
    this.stateDir =
      opts.stateDir ??
      process.env.CMUX_AGENT_HOOK_STATE_DIR ??
      join(homedir(), ".cmuxterm");
    this.debounceMs = opts.debounceMs ?? 50;
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    this.listFiles = opts.listFiles ?? defaultListFiles;
    this.readFile = opts.readFile ?? defaultReadFile;
    this.fileExists = opts.fileExists ?? existsSync;
    this.watchDir = opts.watchDir ?? defaultWatchDir;
    this.scheduleTimer = opts.scheduleTimer ?? (setTimeout as NonNullable<CmuxStoreSourceOpts["scheduleTimer"]>);
    this.cancelTimer = opts.cancelTimer ?? (clearTimeout as NonNullable<CmuxStoreSourceOpts["cancelTimer"]>);
    this.log = opts.log ?? (() => {});
  }

  start(deps: LifecycleSourceDeps): void {
    this.deps = deps;
    // Initial scan before any watch events fire.
    this.scan();
    // Watch for subsequent changes, debounced.
    try {
      this.stopWatcher = this.watchDir(this.stateDir, () => this.scheduleDebounced());
    } catch (e) {
      this.log(`cmux-store: failed to watch ${this.stateDir}: ${(e as Error).message}`);
    }
  }

  stop(): void {
    if (this.debounceTimer !== undefined) {
      this.cancelTimer(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.stopWatcher?.();
    this.stopWatcher = undefined;
    this.deps = undefined;
    this.cache.clear();
  }

  /** Returns the last-reported snapshot for a known crew (liveness floor). */
  snapshot(taskId: string): LifecycleSnapshot | undefined {
    return this.cache.get(taskId);
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private scheduleDebounced(): void {
    if (this.debounceTimer !== undefined) {
      this.cancelTimer(this.debounceTimer);
    }
    this.debounceTimer = this.scheduleTimer(() => {
      this.debounceTimer = undefined;
      this.scan();
    }, this.debounceMs);
  }

  private scan(): void {
    if (!this.deps) return;
    for (const filename of this.listFiles(this.stateDir)) {
      this.scanFile(filename);
    }
  }

  private scanFile(filename: string): void {
    const deps = this.deps!;
    const filePath = join(this.stateDir, filename);
    const lockPath = `${filePath}.lock`;

    // Skip files that cmux is currently writing.
    if (this.fileExists(lockPath)) {
      this.log(`cmux-store: skipping ${filename} (locked)`);
      return;
    }

    const raw = this.readFile(filePath);
    if (!raw) return;

    let parsed: StoreFile;
    try {
      parsed = JSON.parse(raw) as StoreFile;
    } catch {
      this.log(`cmux-store: failed to parse ${filename}`);
      return;
    }

    for (const session of Object.values(parsed.sessions ?? {})) {
      this.processSession(session, deps);
    }
  }

  private processSession(session: StoreSession, deps: LifecycleSourceDeps): void {
    if (!session.sessionId || !session.cwd || typeof session.pid !== "number") return;

    const hint: CorrelationHint = {
      cwd: session.cwd,
      pid: session.pid,
      sessionId: session.sessionId,
    };
    const resolved = deps.resolve(hint);
    if (!resolved) return;

    // Pid-verify liveness.
    let alive = this.isPidAlive(session.pid);

    // Hibernation guard (research §194): cmux reclaims RAM from idle crews by
    // suspending or reaping the pid. Only treat a dead pid as logically alive
    // when the session is restorable AND idle — a running/needsInput session
    // with a dead pid is genuinely gone, not hibernated.
    if (!alive && session.isRestorable === true && session.agentLifecycle === "idle") {
      alive = true;
    }

    const snap: LifecycleSnapshot = {
      taskId: resolved.id,
      state: parseLifecycleState(session.agentLifecycle),
      alive,
      // "agent": the store carries the agent's own reported lifecycle state,
      // not a scan inference. needsInput from the store is authoritative.
      origin: "agent",
      at: Math.floor((session.updatedAt ?? 0) * 1000),
      pid: session.pid,
      ...(session.lastBody ? { detail: { note: session.lastBody } } : {}),
    };

    this.cache.set(resolved.id, snap);
    deps.report(snap);
  }
}

// ── private helpers ──────────────────────────────────────────────────────────

function parseLifecycleState(s: string | undefined): LifecycleState {
  if (s === "running" || s === "idle" || s === "needsInput" || s === "unknown") {
    return s;
  }
  return "unknown";
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultListFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter(
      (f) => f.endsWith("-hook-sessions.json") && !f.endsWith(".lock"),
    );
  } catch {
    return [];
  }
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function defaultWatchDir(dir: string, cb: () => void): () => void {
  const w = watch(dir, (_event, filename) => {
    if (typeof filename === "string" && filename.endsWith("-hook-sessions.json")) {
      cb();
    }
  });
  return () => w.close();
}
