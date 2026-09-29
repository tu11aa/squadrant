// gate-opencode-run.ts — `squadrant gate opencode-run` (#828 P6-C phase 2)
//
// The command a gate-wrapped opencode crew/captain pane runs in place of a
// bare `opencode …`. It hands squadrant's already-allocated port to
// @squadrant-ai/auto-gate's buildRunPlan (the package's documented host-port
// injection point), then runs opencode + the auto-gate watcher as one
// supervised unit via supervise(). Any failure in that pipeline — a thrown
// buildRunPlan/supervise, a missing `opencode` binary, or supervise()
// resolving non-zero within the startup window (a watcher/adapter bug that
// tears the session down without throwing) — falls back to launching
// opencode directly on the same port: a gate defect must never stop a crew
// from starting.

import { spawn as nodeSpawn, type StdioOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildRunPlan, supervise, type RunPlan, type SpawnedProc, type SupervisorDeps } from "@squadrant-ai/auto-gate";

/** How long after the auto-gate pipeline starts a non-zero supervise() exit
 *  still counts as a startup failure (→ fall back) rather than a normal
 *  session end (→ propagate). See runGateOpencodeRun. */
export const GATE_STARTUP_WINDOW_MS = 10_000;

export interface GateOpencodeRunOptions {
  /** squadrant's own port for opencode's embedded HTTP server (SSE bridge). */
  port: number;
  /** Extra opencode args, e.g. ["--session", id]. Must NOT include --port —
   *  buildRunPlan owns that flag via `allocate`. */
  args: string[];
}

export interface GateOpencodeRunDeps {
  buildRunPlan?: (i: { args: string[]; allocate: () => Promise<number> }) => Promise<RunPlan>;
  supervise?: (plan: RunPlan, deps?: SupervisorDeps) => Promise<number>;
  /** Injectable for tests; the watcher's node spawn, so the wrapper can point
   *  its stdio at the log file. Defaults to node's spawn. */
  spawnProc?: (cmd: string, args: string[], opts: { stdio: StdioOptions; detached?: boolean; env?: NodeJS.ProcessEnv }) => SpawnedProc;
  /** Path of the gate log (#866). Defaults to the per-project state file. */
  logPath?: string;
  /** Injectable for tests; defaults to a non-detached, stdio-inherited node
   *  spawn (see launchOpencodeDirect's default below for why). */
  spawnDirect?: (cmd: string, args: string[]) => {
    on(event: "exit", cb: (code: number | null) => void): void;
    on(event: "error", cb: (err: Error) => void): void;
  };
  log?: (m: string) => void;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

/** Per-project gate log under the squadrant state dir (#866). */
function defaultGateLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const project = env.SQUADRANT_CREW_PROJECT || "_shared";
  return join(homedir(), ".config", "squadrant", "state", project, "auto-gate-opencode.log");
}

/** Today's plain behavior: opencode, no adapter. Used as the runtime fallback
 *  when the auto-gate pipeline itself fails. */
function launchOpencodeDirect(
  o: GateOpencodeRunOptions,
  spawnDirect: NonNullable<GateOpencodeRunDeps["spawnDirect"]>,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnDirect("opencode", [...o.args, "--port", String(o.port)]);
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

export async function runGateOpencodeRun(
  o: GateOpencodeRunOptions,
  deps: GateOpencodeRunDeps = {},
): Promise<number> {
  // #866: the pane TTY belongs to opencode's TUI. Everything else (the
  // watcher's output, our own log lines) goes to an append-mode file; if it
  // can't be opened, discard rather than fall back to the TTY.
  let logFd: number | undefined;
  try {
    const logPath = deps.logPath ?? defaultGateLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    logFd = openSync(logPath, "a");
  } catch {
    logFd = undefined;
  }
  const fileLog = (m: string) => {
    if (logFd === undefined) return;
    try {
      writeSync(logFd, `[squadrant] ${m}\n`);
    } catch {
      // never let logging break the launch
    }
  };
  const log = deps.log ?? fileLog;
  const spawnProc = deps.spawnProc ?? nodeSpawn;
  const gateSpawn: NonNullable<SupervisorDeps["spawn"]> = (cmd, args, opts) =>
    spawnProc(cmd, args, {
      ...opts,
      // opencode (the only detached child) keeps the pane; the watcher is silenced.
      stdio: opts.detached ? "inherit" : logFd === undefined ? "ignore" : ["ignore", logFd, logFd],
    }) as SpawnedProc;
  const buildPlan = deps.buildRunPlan ?? buildRunPlan;
  const runSupervise = deps.supervise ?? supervise;
  // Not detached: a detached child gets its own session (setsid) and loses
  // the controlling terminal, which breaks an interactive TUI running in a
  // pane. inherit stdio so it takes over the pane exactly like a bare
  // `opencode` invocation would.
  const spawnDirect = deps.spawnDirect ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: "inherit" }));
  const now = deps.now ?? Date.now;

  const startedAt = now();
  try {
    const plan = await buildPlan({ args: o.args, allocate: async () => o.port });
    const code = await runSupervise(plan, { log, spawn: gateSpawn });
    if (code !== 0 && now() - startedAt < GATE_STARTUP_WINDOW_MS) {
      log(`gate: auto-gate opencode adapter exited early (code ${code}) — launching opencode directly`);
      return launchOpencodeDirect(o, spawnDirect);
    }
    return code;
  } catch (e) {
    log(`gate: auto-gate opencode adapter failed (${(e as Error).message}) — launching opencode directly`);
    return launchOpencodeDirect(o, spawnDirect);
  } finally {
    if (logFd !== undefined) closeSync(logFd);
  }
}
