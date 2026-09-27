// gate-opencode-run.ts — `squadrant gate opencode-run` (#828 P6-C phase 2)
//
// The command a gate-wrapped opencode crew/captain pane runs in place of a
// bare `opencode …`. It hands squadrant's already-allocated port to
// @squadrant-ai/auto-gate's buildRunPlan (the package's documented host-port
// injection point), then runs opencode + the auto-gate watcher as one
// supervised unit via supervise(). Any failure in that pipeline — a thrown
// buildRunPlan/supervise, a missing `opencode` binary, anything — falls back
// to launching opencode directly on the same port: a gate defect must never
// stop a crew from starting.

import { spawn as nodeSpawn } from "node:child_process";
import { buildRunPlan, supervise, type RunPlan } from "@squadrant-ai/auto-gate";

export interface GateOpencodeRunOptions {
  /** squadrant's own port for opencode's embedded HTTP server (SSE bridge). */
  port: number;
  /** Extra opencode args, e.g. ["--session", id]. Must NOT include --port —
   *  buildRunPlan owns that flag via `allocate`. */
  args: string[];
}

export interface GateOpencodeRunDeps {
  buildRunPlan?: (i: { args: string[]; allocate: () => Promise<number> }) => Promise<RunPlan>;
  supervise?: (plan: RunPlan, deps?: { log?: (m: string) => void }) => Promise<number>;
  /** Injectable for tests; defaults to a detached, stdio-inherited node spawn. */
  spawnDirect?: (cmd: string, args: string[]) => {
    on(event: "exit", cb: (code: number | null) => void): void;
    on(event: "error", cb: (err: Error) => void): void;
  };
  log?: (m: string) => void;
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
  const log = deps.log ?? ((m: string) => process.stderr.write(`[squadrant] ${m}\n`));
  const buildPlan = deps.buildRunPlan ?? buildRunPlan;
  const runSupervise = deps.supervise ?? supervise;
  const spawnDirect =
    deps.spawnDirect ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: "inherit", detached: true }));

  try {
    const plan = await buildPlan({ args: o.args, allocate: async () => o.port });
    return await runSupervise(plan, { log });
  } catch (e) {
    log(`gate: auto-gate opencode adapter failed (${(e as Error).message}) — launching opencode directly`);
    return launchOpencodeDirect(o, spawnDirect);
  }
}
