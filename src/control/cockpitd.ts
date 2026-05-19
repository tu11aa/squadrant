// src/control/cockpitd.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn as realSpawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createStore } from "./store.js";
import { createDaemon } from "./daemon.js";
import { startServer } from "./protocol.js";
import { runHeadless } from "./headless-launcher.js";
import type { TaskRecord } from "./types.js";

export interface CockpitdOpts {
  stateRoot?: string;
  sockPath?: string;
  sweepMs?: number; // 0 disables the interval (tests)
  isPidAlive?: (pid: number) => boolean; // injectable for the headless reconcile path (tests)
  spawn?: typeof realSpawn;
}

export function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === "EPERM"; } // EPERM = alive but not ours; ESRCH = dead
}

export function startCockpitd(opts: CockpitdOpts = {}) {
  const stateRoot = opts.stateRoot ?? join(homedir(), ".config", "cockpit", "state");
  const sockPath = opts.sockPath ?? join(homedir(), ".config", "cockpit", "cockpit.sock");
  const store = createStore(stateRoot);
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const spawn = opts.spawn ?? realSpawn;
  const resultsDir = join(stateRoot, "_results");
  mkdirSync(resultsDir, { recursive: true });
  const writeResult = (id: string, payload: string) => {
    const p = join(resultsDir, `${id}.txt`);
    writeFileSync(p, payload);
    return p;
  };
  const ingest = (project: string) => (e: import("./types.js").ControlEvent) =>
    void d.handle({ kind: "event", project, event: e });

  const d = createDaemon({
    store, now: () => Date.now(), isPidAlive,
    launchHeadless: async (rec) => {
      await runHeadless({
        provider: rec.provider, task: rec.task, id: rec.id, sessionId: rec.sessionId,
        spawn, emit: ingest(rec.project), writeResult,
      });
    },
  });

  d.reconcile(); // crash recovery on boot

  const server = startServer(sockPath, async (msg: any) => {
    if (msg.kind === "seed") { store.put(msg.record as TaskRecord); return { ok: true }; }
    return d.handle(msg);
  });
  // Minimal lifecycle logging (red-team #2: the log was a timestampless wall
  // of crash stacks with no "started" marker).
  const log = (m: string) => process.stderr.write(`[cockpitd] ${new Date().toISOString()} ${m}\n`);
  log(`started pid=${process.pid} sock=${sockPath} stateRoot=${stateRoot}`);

  let timer: NodeJS.Timeout | undefined;
  if (opts.sweepMs && opts.sweepMs > 0) {
    timer = setInterval(() => d.sweep(), opts.sweepMs);
    timer.unref?.();
  }

  return {
    stop() { if (timer) clearInterval(timer); server.close(); log("stopped"); },
  };
}

// Executed by launchd (ProgramArguments → this file's compiled .js).
if (process.argv[1] && process.argv[1].endsWith("cockpitd.js")) {
  const h = startCockpitd({ sweepMs: 30000 });
  process.on("SIGTERM", () => { h.stop(); process.exit(0); });
}
