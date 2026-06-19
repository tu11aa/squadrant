// Crew child-process lifecycle management.
// Extracted from packages/cli/src/commands/crew.ts so it is importable from
// packages other than cli and testable with an injected exec function.

import { exec as nodeExec } from "node:child_process";

type ExecFn = (
  cmd: string,
  opts: { maxBuffer: number },
  cb: (err: Error | null, stdout: string) => void,
) => void;

/** Kill every process that inherited COCKPIT_CREW_TASK_ID=<taskId> from the
 *  crew's shell env prefix. Uses `ps auxE` which exposes env vars for node
 *  processes on macOS (vitest workers, the crew CLI, etc.). Best-effort:
 *  swallows all errors so a childless crew still closes cleanly.
 *
 *  @param graceMs - ms between SIGTERM and SIGKILL (default 2 s; pass a short
 *    value in tests to avoid waiting)
 *  @param execFn - injectable for testing; defaults to node:child_process.exec
 */
export async function reapCrewChildren(
  taskId: string,
  graceMs = 2000,
  execFn: ExecFn = nodeExec,
): Promise<void> {
  const marker = `COCKPIT_CREW_TASK_ID=${taskId}`;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      // `ps auxE` dumps every process's full env, which on a busy machine far
      // exceeds exec's default 1 MB maxBuffer (~2.7 MB with ~1k procs). Without
      // a raised cap the call errors with "maxBuffer length exceeded", the outer
      // catch swallows it, and the reap silently no-ops — leaving crew children
      // alive. 64 MB comfortably covers thousands of processes.
      execFn("ps auxE", { maxBuffer: 64 * 1024 * 1024 }, (err, out) =>
        err ? reject(err) : resolve(out),
      );
    });
    const pids: number[] = [];
    for (const line of stdout.split("\n").slice(1)) {
      if (!line.includes(marker)) continue;
      const pid = parseInt(line.trim().split(/\s+/)[1], 10);
      if (!isNaN(pid) && pid !== process.pid) pids.push(pid);
    }
    if (pids.length === 0) return;
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    await new Promise<void>((r) => setTimeout(r, graceMs));
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  } catch { /* best-effort */ }
}
