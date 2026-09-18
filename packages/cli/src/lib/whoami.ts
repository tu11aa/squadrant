// packages/cli/src/lib/whoami.ts
//
// #669: resolve *which* agent session is asking — "which one am I".
//
// Positive signals only, in priority order:
//   1. `$CLAUDE_CODE_MESSAGING_SOCKET` — set by Claude Code itself for its own
//      process tree. The portable self-identifier (never pgrep: macOS pgrep
//      omits the invoking process and its ancestors — trap 1).
//   2. `SQUADRANT_CREW_TASK_ID` / `SQUADRANT_CREW_PROJECT` — a crew's own ids.
//   3. `SQUADRANT_ROLE` — e.g. `captain`, set at the one captain-launch site.
//   4. The captain-address record for the project derived from cwd.
//
// Pure and injectable: no filesystem, no env reads beyond what is passed in.

export interface WhoamiTaskRecord {
  provider?: string;
  sessionId?: string;
  messagingSocketPath?: string;
  serverPort?: number;
}

export interface WhoamiCaptainRecord {
  agent?: string;
  port?: number;
  sessionId?: string;
  directory?: string;
}

export interface WhoamiDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Registered projects: name → absolute path. */
  projects: Record<string, string>;
  readCaptain: (project: string) => WhoamiCaptainRecord | null;
  readTask: (project: string, id: string) => WhoamiTaskRecord | null;
  readClaudeBySocket: (socketPath: string) => { sessionId?: string } | undefined;
}

export type WhoamiSource = "claude-registry" | "captain-record" | "task-record" | "none";

export interface WhoamiRecord {
  project: string | null;
  role: string;
  agent: string | null;
  sessionId: string | null;
  address: string | null;
  source: WhoamiSource;
  note?: string;
}

export interface WhoamiResult {
  /** false ⇒ the caller could not be identified; the CLI exits non-zero. */
  ok: boolean;
  record: WhoamiRecord;
}

/**
 * The project whose registered path is the longest prefix of `cwd`.
 * Longest-prefix (not first-match) so a nested project wins over its parent.
 */
export function projectForCwd(cwd: string, projects: Record<string, string>): string | null {
  let best: { name: string; len: number } | null = null;
  for (const [name, raw] of Object.entries(projects)) {
    const norm = raw.replace(/\/+$/, "");
    if (!norm) continue;
    if (cwd === norm || cwd.startsWith(norm + "/")) {
      if (!best || norm.length > best.len) best = { name, len: norm.length };
    }
  }
  return best?.name ?? null;
}

export function resolveWhoami(deps: WhoamiDeps): WhoamiResult {
  const env = deps.env;
  const crewTaskId = env.SQUADRANT_CREW_TASK_ID;
  const socketEnv = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const project = env.SQUADRANT_CREW_PROJECT || projectForCwd(deps.cwd, deps.projects) || null;
  const role = crewTaskId ? "crew" : (env.SQUADRANT_ROLE ?? "unknown");

  // 1. Claude self-identification. A claude captain OR crew answers here.
  if (socketEnv) {
    const reg = deps.readClaudeBySocket(socketEnv);
    return {
      ok: true,
      record: {
        project,
        role,
        agent: "claude",
        sessionId: reg?.sessionId ?? null,
        address: socketEnv,
        source: "claude-registry",
        ...(reg?.sessionId ? {} : { note: "socket found but no matching registry entry yet" }),
      },
    };
  }

  // 2. Crew (non-claude — a claude crew is caught above): the task record is ground truth.
  if (crewTaskId) {
    if (!project) {
      return {
        ok: false,
        record: {
          project: null, role, agent: null, sessionId: null, address: null, source: "none",
          note: `crew task ${crewTaskId} but no project (SQUADRANT_CREW_PROJECT unset and cwd matches no registered project)`,
        },
      };
    }
    const task = deps.readTask(project, crewTaskId);
    if (!task) {
      return {
        ok: false,
        record: {
          project, role, agent: null, sessionId: null, address: null, source: "none",
          note: `crew task record ${project}/${crewTaskId} not found`,
        },
      };
    }
    return {
      ok: true,
      record: {
        project,
        role,
        agent: task.provider ?? null,
        sessionId: task.sessionId ?? null,
        // opencode crews carry a loopback port; claude crews a UDS socket.
        address:
          task.messagingSocketPath ??
          (task.serverPort != null ? `http://127.0.0.1:${task.serverPort}` : null),
        source: "task-record",
      },
    };
  }

  // 3. Captain (or any identified role) with a recorded address for this project.
  if (project) {
    const rec = deps.readCaptain(project);
    if (rec) {
      return {
        ok: true,
        record: {
          project,
          role,
          agent: rec.agent ?? null,
          sessionId: rec.sessionId ?? null,
          address: rec.port != null ? `http://127.0.0.1:${rec.port}` : null,
          source: "captain-record",
          ...(rec.sessionId ? {} : { note: "captain record has no sessionId yet (cold start)" }),
        },
      };
    }
  }

  return {
    ok: false,
    record: {
      project,
      role,
      agent: null,
      sessionId: null,
      address: null,
      source: "none",
      note: "no SQUADRANT_* marker, no $CLAUDE_CODE_MESSAGING_SOCKET, and no captain/task record for this cwd",
    },
  };
}
