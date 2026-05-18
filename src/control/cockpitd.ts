// src/control/cockpitd.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";
import { createDaemon } from "./daemon.js";
import { startServer } from "./protocol.js";
import type { TaskRecord } from "./types.js";

export interface CockpitdOpts {
  stateRoot?: string;
  sockPath?: string;
  sweepMs?: number; // 0 disables the interval (tests)
}

export function startCockpitd(opts: CockpitdOpts = {}) {
  const stateRoot = opts.stateRoot ?? join(homedir(), ".config", "cockpit", "state");
  const sockPath = opts.sockPath ?? join(homedir(), ".config", "cockpit", "cockpit.sock");
  const store = createStore(stateRoot);
  const isPidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const d = createDaemon({ store, now: () => Date.now(), isPidAlive });

  d.reconcile(); // crash recovery on boot

  const server = startServer(sockPath, async (msg: any) => {
    if (msg.kind === "seed") { store.put(msg.record as TaskRecord); return { ok: true }; }
    return d.handle(msg);
  });

  let timer: NodeJS.Timeout | undefined;
  if (opts.sweepMs && opts.sweepMs > 0) {
    timer = setInterval(() => d.sweep(), opts.sweepMs);
    timer.unref?.();
  }

  return {
    stop() { if (timer) clearInterval(timer); server.close(); },
  };
}

// Executed by launchd (ProgramArguments → this file's compiled .js).
if (process.argv[1] && process.argv[1].endsWith("cockpitd.js")) {
  const h = startCockpitd({ sweepMs: 30000 });
  process.on("SIGTERM", () => { h.stop(); process.exit(0); });
}
