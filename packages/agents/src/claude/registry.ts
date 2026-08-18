// packages/agents/src/claude/registry.ts
//
// Reader for Claude Code's session registry (#667 slice 1).
//
// Discovery is a DIRECTORY OF JSON FILES, not a service: ~/.claude/sessions/<pid>.json,
// one per live session, written by the session itself. Nobody maintains it — a
// SIGKILLed session never cleans up — so every reader does its own liveness check.
//
// This file is pure: parsing and mapping only. Polling, fs access, and the
// process-liveness check live in peer-registry-source.ts so both are testable
// without touching a real home directory.
import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LifecycleSnapshot } from "@squadrant/core";
import type { TaskRecord } from "@squadrant/shared";

/** Where Claude Code writes one JSON file per live session. */
export const CLAUDE_SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/** The subset of a registry entry squadrant reads. Claude writes more fields. */
export interface ClaudeRegistryEntry {
  pid: number;
  sessionId?: string;
  cwd?: string;
  /** "cli" for interactive sessions; "sdk-cli" sessions carry NO status field. */
  entrypoint?: string;
  /** Four values, not two. Absent on sdk-cli sessions. */
  status?: "idle" | "busy" | "shell" | "waiting";
  /** Only present alongside status:"waiting", e.g. "permission prompt". */
  waitingFor?: string;
  statusUpdatedAt?: number;
  messagingSocketPath?: string;
  /** Pins the entry to a process INSTANCE — guards against pid reuse. */
  procStart?: string;
}

/** Only `<pid>.json`; Claude Code applies the same filter to its own reads. */
const PID_JSON = /^(\d+)\.json$/;

/**
 * Parse a directory listing into entries, skipping anything unreadable.
 *
 * Torn writes are expected, not exceptional: a reader can catch a file mid-rewrite,
 * and a session can exit between readdir and readFile. Both yield "skip this entry",
 * never a throw — one bad file must not blind the source to every other session.
 *
 * The pid comes from the FILENAME, which is authoritative; the body may be stale.
 */
export function parseRegistryDir(
  files: string[],
  readFile: (name: string) => string,
): ClaudeRegistryEntry[] {
  const out: ClaudeRegistryEntry[] = [];
  for (const name of files) {
    const m = PID_JSON.exec(name);
    if (!m) continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(readFile(name)) as Record<string, unknown>;
    } catch {
      continue; // torn write, or the file vanished — both are normal
    }
    out.push({ ...(json as object), pid: parseInt(m[1], 10) } as ClaudeRegistryEntry);
  }
  return out;
}

/**
 * Map one registry entry to a normalized snapshot.
 *
 * origin is ALWAYS "agent". The registry is the session's own self-report;
 * squadrant happens to read it by polling, but `origin` describes how far the
 * SOURCE is trusted, not the transport used to fetch it. Marking it "scan" would
 * make reduceLifecycle rule 2 silently discard every `waitingFor: "permission
 * prompt"` — the single most valuable signal in this design.
 *
 * Three guards, each of which manufactures a new class of false signal if omitted:
 *   1. `alive` (caller's kill(pid,0)) — a crashed session's status is frozen and
 *      looks fresh forever. This is today's phantom CREW STALLED, relocated.
 *   2. `statusUpdatedAt` becomes `at`, so reduceLifecycle can reject a stale read.
 *   3. Absence ≠ idle. No status field ⇒ "unknown".
 */
export function toLifecycleSnapshot(
  entry: ClaudeRegistryEntry,
  taskId: string,
  alive: boolean,
  now: number,
): LifecycleSnapshot {
  const at = entry.statusUpdatedAt ?? now;
  const base = { taskId, alive, origin: "agent" as const, at, pid: entry.pid };

  // Guard 1: a dead process has no current state, whatever its file still says.
  if (!alive) return { ...base, state: "unknown" };

  switch (entry.status) {
    case "busy":
    case "shell":
      return { ...base, state: "running" };
    case "idle":
      return { ...base, state: "idle" };
    case "waiting":
      return {
        ...base,
        state: "needsInput",
        detail: { reason: entry.waitingFor, note: entry.waitingFor },
      };
    default:
      // Guard 3: sdk-cli sessions (no status) and any future value squadrant
      // does not recognise. Never guess "idle" here.
      return { ...base, state: "unknown" };
  }
}

/** #667 slice 3: read status for a single task record. */
export function readClaudeStatus(task: TaskRecord | undefined): "idle" | "busy" | "shell" | "waiting" | undefined {
  if (!task || !task.pid) return undefined;
  let files: string[];
  try {
    files = fs.readdirSync(CLAUDE_SESSIONS_DIR);
  } catch {
    return undefined;
  }
  const entries = parseRegistryDir(files, (name) => fs.readFileSync(join(CLAUDE_SESSIONS_DIR, name), "utf8"));
  const entry = entries.find((e) => e.pid === task.pid && (!task.sessionId || e.sessionId === task.sessionId));
  return entry?.status;
}

/** #667 slice 4: read status for a captain session identified by its project directory. */
export function readClaudeStatusByCwd(cwd: string): "idle" | "busy" | "shell" | "waiting" | undefined {
  let files: string[];
  try {
    files = fs.readdirSync(CLAUDE_SESSIONS_DIR);
  } catch {
    return undefined;
  }
  const entries = parseRegistryDir(files, (name) => fs.readFileSync(join(CLAUDE_SESSIONS_DIR, name), "utf8"));
  // A captain's session has the project directory as its cwd.
  const entry = entries.find((e) => e.cwd === cwd);
  return entry?.status;
}
