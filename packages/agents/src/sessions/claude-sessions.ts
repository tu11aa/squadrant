// packages/agents/src/sessions/claude-sessions.ts
//
// #669: read-only introspection of live Claude Code sessions, for
// `squadrant sessions`. The source is Claude Code's own registry
// (~/.claude/sessions/<pid>.json) — see claude/registry.ts for the parsing
// and liveness rules this reuses.
//
// Lifted from the peers reference reader: the registry has no owner, so a
// crashed session leaves a fresh-looking file forever. pid liveness is the
// only thing that distinguishes "live" from "frozen last status".
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_SESSIONS_DIR, parseRegistryDir } from "../claude/registry.js";
import type { AgentSession } from "../drivers/types.js";

export interface ClaudeSessionListDeps {
  /** Injectable for tests. Defaults to reading CLAUDE_SESSIONS_DIR. */
  readdir?: () => string[];
  readFile?: (name: string) => string;
  /** signal 0 = "does a process with this pid exist?". Injectable for tests. */
  isAlive?: (pid: number) => boolean;
}

/** EPERM means the process exists but belongs to another user — still alive. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function listClaudeSessions(deps: ClaudeSessionListDeps = {}): AgentSession[] {
  let files: string[];
  try {
    files = (deps.readdir ?? (() => readdirSync(CLAUDE_SESSIONS_DIR)))();
  } catch {
    // A missing directory is normal (no sessions / feature off).
    return [];
  }
  const readFile = deps.readFile ?? ((n: string) => readFileSync(join(CLAUDE_SESSIONS_DIR, n), "utf8"));
  const isAlive = deps.isAlive ?? defaultIsAlive;

  return parseRegistryDir(files, readFile).map((entry) => {
    const alive = isAlive(entry.pid);
    // Guard: a dead process has no current state, whatever its file still says.
    const status = alive ? (entry.status ?? "unknown") : "stale";
    return {
      id: entry.sessionId ?? String(entry.pid),
      pid: entry.pid,
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      status,
      ...(entry.messagingSocketPath ? { address: entry.messagingSocketPath } : {}),
    };
  });
}
