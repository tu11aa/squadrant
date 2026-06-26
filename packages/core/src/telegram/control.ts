// Daemon-side capabilities for the Telegram control surfaces (#402/#403). The
// CLI layer owns process spawning + socket access; the core bridge only sees the
// injected closures. EVERYTHING that shells out uses async execFile (promisified)
// with an argv array — never *Sync on the daemon poll path (event-loop
// starvation, learning #2) and never a shell string (argv already validated by
// parseCommand).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sendRequest } from "../protocol.js";

const pExecFile = promisify(execFile);

// Telegram message hard limit is 4096 chars; cap below it with headroom for the
// truncation marker + any reply framing.
const MAX_OUTPUT = 3500;

/** Combine a command's stdout/stderr into one capped, human-readable reply. */
export function capOutput(stdout: string, stderr: string, max = MAX_OUTPUT): string {
  const out = stdout.trim();
  const err = stderr.trim();
  let combined = out;
  if (err) combined = combined ? `${combined}\n[stderr] ${err}` : `[stderr] ${err}`;
  if (!combined) combined = "(no output)";
  if (combined.length > max) combined = combined.slice(0, max) + "\n…[truncated]";
  return combined;
}

const COMMAND_TIMEOUT_MS = 60_000;

/** Run a curated squadrant CLI argv via async execFile, returning capped output.
 *  argv is the validated vector from parseCommand — passed as an array (no shell). */
export function createRunCommand(cliBin: string): (argv: string[]) => Promise<string> {
  return async (argv: string[]) => {
    try {
      const { stdout, stderr } = await pExecFile(
        process.execPath,
        [cliBin, ...argv],
        { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
      return capOutput(stdout ?? "", stderr ?? "");
    } catch (e) {
      // execFile rejects on non-zero exit / timeout; surface its captured output.
      const err = e as { stdout?: string; stderr?: string; message?: string };
      return capOutput(err.stdout ?? "", err.stderr ?? err.message ?? "command failed");
    }
  };
}

/** Liveness probe via the daemon health endpoint (mirrors group.ts isCaptainAlive). */
export function createIsCaptainAlive(sock: string): (project: string) => Promise<boolean> {
  return async (project: string) => {
    try {
      const health = (await sendRequest(sock, { kind: "health", project }, 5000)) as Array<{
        kind: string; project: string; state: string;
      }>;
      const captain = health?.find((h) => h.kind === "captain" && h.project === project);
      return captain != null && captain.state !== "gone" && captain.state !== "unknown";
    } catch {
      return false;
    }
  };
}

/** Boot a captain via async execFile (NEVER execSync on the daemon hot path). */
export function createLaunch(cliBin: string): (project: string) => Promise<void> {
  return async (project: string) => {
    await pExecFile(process.execPath, [cliBin, "launch", project], { timeout: 30_000 });
  };
}
