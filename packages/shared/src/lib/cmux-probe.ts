// src/lib/cmux-probe.ts
//
// #348 (part of #332): the hybrid gate. Answer "can a NON-cmux process reach the
// cmux control socket right now?" — i.e. is daemon-direct delivery viable?
//
// See docs/specs/2026-06-16-cmux-socket-auth-daemon-direct-design.md §4.2.
//
// FAITHFULNESS: cmuxOnly mode checks the connecting process's parent chain and
// rejects anything not descended from the cmux app. Prior research was
// CONTAMINATED because it ran inside a cmux pane and kept cmux ancestry even
// under `env -i`. A faithful probe MUST run from a process reparented to launchd
// (PPID ⇒ 1). We achieve that with a launcher→worker double-fork: the launcher
// exits immediately, orphaning the worker, which waits until process.ppid === 1
// before touching the socket.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCmuxBin } from "./cmux-bin.js";

export type ProbeVerdict = "reachable" | "denied" | "unknown";

export interface ProbeRawResult {
  ok: boolean;
  stderr?: string;
}

// cmux's parentage rejection message (and generic socket permission errors).
const DENIED_RE = /access denied|only processes started inside cmux|permission denied/i;

/**
 * Pure. Map a raw probe result to a verdict.
 * - ok ⇒ reachable (daemon-direct viable)
 * - access-denied stderr ⇒ denied (socket still cmuxOnly — restart needed)
 * - anything else ⇒ unknown (fail soft → stay on relay)
 */
export function classifyProbe(r: ProbeRawResult): ProbeVerdict {
  if (r.ok) return "reachable";
  if (r.stderr && DENIED_RE.test(r.stderr)) return "denied";
  return "unknown";
}

export interface ProbeOpts {
  /** Injectable runner (tests). Default = orphan-escape spawn of a cmux read. */
  run?: () => Promise<ProbeRawResult>;
  /** Overall budget for the orphan probe (default 8s). */
  timeoutMs?: number;
}

/**
 * Probe whether a non-cmux process can reach the cmux control socket. Never
 * throws — a failed/timed-out probe degrades to "unknown" so the caller stays on
 * the zero-setup relay.
 */
export async function probeCmuxDaemonDirect(opts: ProbeOpts = {}): Promise<ProbeVerdict> {
  const run = opts.run ?? (() => orphanProbe(opts.timeoutMs ?? 8000));
  try {
    return classifyProbe(await run());
  } catch {
    return "unknown";
  }
}

// The worker script, run via `node`. Two modes in one file:
//   launch: spawn the worker detached, then exit → worker is orphaned to launchd
//   work:   wait until PPID===1 (no cmux ancestor), run the cmux read, write JSON
// argv: [node, script, mode, resultFile, cmuxBin]
const WORKER_SRC = `
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const [mode, resultFile, cmuxBin] = process.argv.slice(2);
if (mode === "launch") {
  const child = spawn(process.execPath, [process.argv[1], "work", resultFile, cmuxBin], {
    detached: true, stdio: "ignore",
  });
  child.unref();
  process.exit(0);
}
// work mode: wait to be reparented to launchd (PPID 1), then probe.
const deadline = Date.now() + 3000;
while (process.ppid !== 1 && Date.now() < deadline) {
  const until = Date.now() + 25;
  while (Date.now() < until) { /* tiny busy wait — no timers in a dying orphan */ }
}
let result;
if (process.ppid !== 1) {
  result = { ok: false, stderr: "orphan-timeout" };
} else {
  try {
    execFileSync(cmuxBin, ["workspace", "list", "--json"], {
      encoding: "utf-8", timeout: 10000, env: { ...process.env, CMUX_QUIET: "1" },
    });
    result = { ok: true };
  } catch (e) {
    const stderr = (e && (e.stderr?.toString?.() || e.message)) || "probe failed";
    result = { ok: false, stderr };
  }
}
writeFileSync(resultFile, JSON.stringify(result));
`;

// Default runner: double-fork to a launchd-reparented worker, poll its result.
async function orphanProbe(timeoutMs: number): Promise<ProbeRawResult> {
  const dir = mkdtempSync(join(tmpdir(), "cmux-probe-"));
  const scriptFile = join(dir, "probe-worker.mjs");
  const resultFile = join(dir, "result.json");
  writeFileSync(scriptFile, WORKER_SRC);

  try {
    const launcher = spawn(
      process.execPath,
      [scriptFile, "launch", resultFile, resolveCmuxBin()],
      { detached: true, stdio: "ignore" },
    );
    launcher.unref();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(resultFile)) {
        try {
          return JSON.parse(readFileSync(resultFile, "utf-8")) as ProbeRawResult;
        } catch {
          // partial write — fall through and retry
        }
      }
      await sleep(100);
    }
    return { ok: false, stderr: "probe-timeout" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
