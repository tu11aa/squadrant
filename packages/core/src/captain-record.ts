// Captain-address record (#786). The captain is not a TaskRecord, so its
// addressable transport (port + session id for opencode) lives in a small
// per-project file that the CLI writes at launch and the daemon reads.
//
// Verified constraints this module encodes (docs/specs/2026-09-17-…-design.md §2):
//  - opencode reports `directory` as a realpath; comparisons must normalize both sides.
//  - `-c` resume is project-wide, so a persisted session id is the only safe resume.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CaptainAddress {
  /** The agent that was ACTUALLY launched (post `--agent` override). */
  agent: string;
  /** opencode embedded HTTP port. Absent for claude. */
  port?: number;
  /** opencode session id, resolved after boot. Absent for claude / pre-resolution. */
  sessionId?: string;
  /** realpath of the project directory the captain runs in. */
  directory: string;
  launchedAt: string;
}

export function captainRecordPath(stateRoot: string, project: string): string {
  return join(stateRoot, project, "captain.json");
}

export function readCaptainAddress(stateRoot: string, project: string): CaptainAddress | null {
  try {
    const parsed = JSON.parse(readFileSync(captainRecordPath(stateRoot, project), "utf-8")) as CaptainAddress;
    return parsed && typeof parsed.agent === "string" ? parsed : null;
  } catch {
    return null;   // absent or malformed both mean "no recorded address"
  }
}

export function writeCaptainAddress(stateRoot: string, project: string, addr: CaptainAddress): void {
  const p = captainRecordPath(stateRoot, project);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(addr, null, 2) + "\n");
}

/** realpath when it resolves, the input otherwise (a not-yet-existing dir is not fatal). */
export function realpathOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** True when both paths name the same directory after realpath normalization. */
export function sameDirectory(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const strip = (s: string) => realpathOrSelf(s).replace(/\/+$/, "");
  return strip(a) === strip(b);
}
