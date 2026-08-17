// packages/agents/src/claude/peer-registry-source.ts
//
// LifecycleSource over Claude Code's own session registry (#667 slice 1).
//
// Claude publishes its state to ~/.claude/sessions/<pid>.json. Reading it replaces
// two inferred signals with the agent's self-report:
//   - CREW IDLE fired during a live tool call  → status:"busy" is stated, not guessed
//   - CREW STALLED for a process that is gone  → kill(pid, 0)
//
// This source is READ-ONLY and changes no behaviour. It runs alongside the
// existing v0.15.0 liveness floor; retiring that floor is a later decision made
// on data, not part of this slice.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LifecycleSource, LifecycleSourceDeps, LifecycleSnapshot } from "@squadrant/core";
import { CLAUDE_SESSIONS_DIR, parseRegistryDir, toLifecycleSnapshot } from "./registry.js";

export interface ClaudePeerRegistrySourceDeps {
  /** Injectable for tests. Defaults to reading CLAUDE_SESSIONS_DIR. */
  readdir?: () => string[];
  readFile?: (name: string) => string;
  /** signal 0 = "does a process with this pid exist?" Injectable for tests. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  /** Poll interval in ms. Default 2000. Pass 0 to disable the timer (tests). */
  pollMs?: number;
  log?: (msg: string) => void;
}

/** EPERM means the process exists but belongs to another user — still alive. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ClaudePeerRegistrySource implements LifecycleSource {
  readonly name = "claude-peer-registry";

  private deps?: LifecycleSourceDeps;
  private timer?: NodeJS.Timeout;
  private active = false;
  private lastError: string | null = null;
  /** taskId → last snapshot reported, for dedup and the liveness floor. */
  private cache = new Map<string, LifecycleSnapshot>();

  private readonly readdir: () => string[];
  private readonly readFile: (name: string) => string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly log?: (msg: string) => void;

  constructor(o: ClaudePeerRegistrySourceDeps = {}) {
    this.readdir = o.readdir ?? (() => readdirSync(CLAUDE_SESSIONS_DIR));
    this.readFile = o.readFile ?? ((n) => readFileSync(join(CLAUDE_SESSIONS_DIR, n), "utf8"));
    this.isAlive = o.isAlive ?? defaultIsAlive;
    this.now = o.now ?? Date.now;
    this.pollMs = o.pollMs ?? 2000;
    this.log = o.log;
  }

  start(deps: LifecycleSourceDeps): void {
    this.deps = deps;
    this.active = true;
    // Registering must be inert — no I/O until the first tick fires. Matches the
    // "registering is inert" contract the other sources rely on (squadrantd.ts).
    if (this.pollMs > 0) {
      this.timer = setInterval(() => this.poll(), this.pollMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.deps = undefined;
    this.active = false;
    this.cache.clear();
  }

  health(): { active: boolean; error: string | null } {
    return { active: this.active, error: this.lastError };
  }

  /**
   * Liveness-floor read-back. The port REQUIRES a poll result to be
   * origin:"scan" and forbids it from asserting needsInput — report() already
   * delivered the trusted origin:"agent" signal, and this path must not smuggle
   * a second copy of needsInput past the reducer's precedence rules.
   */
  snapshot(taskId: string): LifecycleSnapshot | undefined {
    const s = this.cache.get(taskId);
    if (!s) return undefined;
    return {
      ...s,
      origin: "scan",
      state: s.state === "needsInput" ? "running" : s.state,
    };
  }

  /** One pass over the registry. Public so tests can drive it without timers. */
  poll(): void {
    if (!this.deps) return;
    let files: string[];
    try {
      files = this.readdir();
    } catch (e) {
      // A missing directory is normal (no Claude sessions / feature off) but is
      // still worth surfacing on the health board rather than swallowing.
      this.lastError = (e as Error).message;
      return;
    }
    this.lastError = null;

    const now = this.now();
    for (const entry of parseRegistryDir(files, this.readFile)) {
      const crew = this.deps.resolve({
        pid: entry.pid,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      });
      // No crew: the operator's own Claude windows, other projects' captains.
      // This is the common case, not an error — stay silent.
      if (!crew) continue;

      const snap = toLifecycleSnapshot(entry, crew.id, this.isAlive(entry.pid), now);
      const prev = this.cache.get(crew.id);
      // Polling re-reads the same file every tick; only transitions carry news.
      if (prev && prev.state === snap.state && prev.alive === snap.alive) continue;
      this.cache.set(crew.id, snap);
      this.deps.report(snap);
      this.log?.(`claude-peer-registry: ${crew.id} → ${snap.state}${snap.alive ? "" : " (dead)"}`);
    }
  }
}
