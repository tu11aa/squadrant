// src/control/headless-launcher.ts
import type { spawn as nodeSpawn } from "node:child_process";
import type { ControlEvent } from "@squadrant/shared";
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

export interface HeadlessHandle {
  result: Promise<void>;
  kill: () => void;
}

// Max bytes retained in the stdout/stderr capture buffers (oldest dropped).
const OUT_CAP = 4 * 1024 * 1024;
const ERR_CAP = 4 * 1024 * 1024;
// Emit task.progress at most once per interval OR once per batch, whichever first.
const PROGRESS_INTERVAL_MS = 250;
const PROGRESS_CHUNK_BATCH = 50;

export function runHeadless(opts: RunHeadlessOpts): HeadlessHandle {
  const adapter = getHeadlessAdapter(opts.provider);
  const argv = adapter.buildCommand(opts.task, opts.sessionId);
  const child = opts.spawn(argv[0], argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.cwd, // undefined → inherit daemon cwd (back-compat)
  });
  opts.emit({ type: "task.started", id: opts.id, pid: child.pid ?? undefined });

  let out = "";
  let err = "";

  // Debounce state — coalesces task.progress to avoid O(chunks) file writes.
  let lastProgressAt = 0;
  let chunksSinceProgress = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function flushProgress(): void {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    lastProgressAt = Date.now();
    chunksSinceProgress = 0;
    opts.emit({ type: "task.progress", id: opts.id }); // stdout activity = liveness
  }

  child.stdout?.on("data", (d) => {
    out += String(d);
    if (out.length > OUT_CAP) out = out.slice(out.length - OUT_CAP);
    chunksSinceProgress++;
    const now = Date.now();
    if (chunksSinceProgress >= PROGRESS_CHUNK_BATCH || now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
      flushProgress();
    } else if (!debounceTimer) {
      const delay = PROGRESS_INTERVAL_MS - (now - lastProgressAt);
      debounceTimer = setTimeout(() => { debounceTimer = null; flushProgress(); }, delay);
    }
  });
  child.stderr?.on("data", (d) => {
    err += String(d);
    if (err.length > ERR_CAP) err = err.slice(err.length - ERR_CAP);
  });

  const result = new Promise<void>((resolve) => {
    child.once("error", (e: Error) => {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      opts.emit({ type: "task.failed", id: opts.id, error: `spawn error: ${e.message}`, exitCode: undefined });
      resolve(); // never hang the daemon; resolve() is idempotent
    });
    child.on("close", (code) => {
      // Flush any batched-but-not-yet-emitted activity before the terminal event.
      if (chunksSinceProgress > 0) flushProgress();
      else if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
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

  return { result, kill: () => child.kill("SIGTERM") };
}
