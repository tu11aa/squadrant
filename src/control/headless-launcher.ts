// src/control/headless-launcher.ts
import type { spawn as nodeSpawn } from "node:child_process";
import type { ControlEvent } from "./types.js";
import { getHeadlessAdapter } from "./headless/registry.js";

export interface RunHeadlessOpts {
  provider: string;
  task: string;
  id: string;
  sessionId?: string;
  /**
   * Working dir for the spawned child. Headless previously inherited the
   * daemon's launchd cwd (`/`) — wrong for every provider, and the reason
   * codex could only do read-only work. Unset → inherit (back-compat).
   */
  cwd?: string;
  spawn: typeof nodeSpawn;
  emit: (e: ControlEvent) => void;
  /** Where to persist captured payload; defaults handled by caller (Task 17). */
  writeResult?: (id: string, payload: string) => string;
}

export function runHeadless(opts: RunHeadlessOpts): Promise<void> {
  const adapter = getHeadlessAdapter(opts.provider);
  const argv = adapter.buildCommand(opts.task, opts.sessionId);
  const child = opts.spawn(argv[0], argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.cwd, // undefined → inherit daemon cwd (back-compat)
  });
  opts.emit({ type: "task.started", id: opts.id, pid: child.pid ?? undefined });

  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => {
    out += String(d);
    opts.emit({ type: "task.progress", id: opts.id }); // stdout activity = liveness
  });
  child.stderr?.on("data", (d) => { err += String(d); });

  return new Promise<void>((resolve) => {
    child.once("error", (e: Error) => {
      opts.emit({ type: "task.failed", id: opts.id, error: `spawn error: ${e.message}`, exitCode: undefined });
      resolve(); // never hang the daemon; resolve() is idempotent
    });
    child.on("close", (code) => {
      const parseInput = (code !== 0 && err) ? err : (out || err);
      const res = adapter.parseResult(parseInput, code ?? 0);
      if (res.outcome === "failed") {
        opts.emit({ type: "task.failed", id: opts.id, error: res.error ?? "non-zero exit", exitCode: res.exitCode });
      } else {
        const ref = opts.writeResult ? opts.writeResult(opts.id, res.payload ?? "") : "";
        opts.emit({ type: "task.done", id: opts.id, resultRef: ref, parseWarning: res.parseWarning });
      }
      resolve();
    });
  });
}
