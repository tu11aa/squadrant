// hooks.ts — 'squadrant hooks <agent> <sub>' — lifecycle hook receiver for NativeHookSource.
//
// The NativeHookSource installer writes 'squadrant hooks claude <sub>' into
// ~/.claude/settings.json. When claude fires a hook, this command:
//   1. reads SQUADRANT_CREW_TASK_ID + SQUADRANT_CREW_PROJECT from the inherited env
//   2. drains stdin for the JSON payload claude passes to every hook
//   3. maps the sub-alias to the appropriate ControlEvent
//   4. sends { kind: "event" } to the daemon via the existing IPC path
//
// Always exits 0 — claude's hook contract requires it (non-zero blocks the conversation).
import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { sendRequest, resolveCurrentProject } from "@squadrant/core";
import { mapClaudeHookToEvent, deriveTranscriptPath, decideCaptainMemoryWrite } from "@squadrant/agents";
import { loadConfig, DAEMON_SOCK_PATH } from "@squadrant/shared";
import type { ControlEvent } from "@squadrant/shared";
import type { CaptainSessionRecord } from "../lib/handoff-facts.js";
import { appendCaptainSession } from "../lib/captain-session-registry.js";

const SOCK = DAEMON_SOCK_PATH;

async function sendToSock(req: unknown): Promise<void> {
  await sendRequest(SOCK, req);
}

/**
 * Map a NativeHookSource sub-alias to a ControlEvent.
 *
 * "stop", "notification", "session-end" delegate to mapClaudeHookToEvent (which
 * handles detectTrailingQuestion and isPermissionNotification). "ask-question"
 * also delegates to it (#560) — it fires from the same PreToolUse+AskUserQuestion
 * matcher as the crew's own hook set, so it must extract the real question/options
 * from tool_input the same way (the previous inline version read a `payload.question`
 * field that doesn't exist in Claude's actual PreToolUse payload, so it always fell
 * back to a generic placeholder). The remaining subs are handled inline.
 */
export function mapHookSub(sub: string, payload: unknown, taskId: string): ControlEvent | null {
  switch (sub) {
    case "session-start":
    case "pre-tool-use":
      return { type: "task.progress", id: taskId, note: sub };
    case "prompt-submit":
      // #470: NativeHookSource path mirrors the crew _hook UserPromptSubmit path.
      // Reducer stamps firstTurnConfirmedAt only once; subsequent submits become liveness.
      return { type: "task.first-turn.confirmed", id: taskId };
    case "stop":
      return mapClaudeHookToEvent("Stop", payload, taskId);
    case "notification":
      return mapClaudeHookToEvent("Notification", payload, taskId);
    case "ask-question":
      return mapClaudeHookToEvent("PreToolUse", payload, taskId);
    case "session-end":
      return mapClaudeHookToEvent("SessionEnd", payload, taskId);
    default:
      return null;
  }
}

/**
 * Pure. Builds a captain-sessions.jsonl record from a raw SessionStart hook
 * payload — #651's ground-truth attribution, recorded at the source instead
 * of inferred later from file mtimes or transcript content. Prefers the
 * documented `transcript_path` field when Claude provides it; falls back to
 * deriving it from session_id+cwd (same layered approach already used for
 * #174's last-assistant-text resolution). Returns null when there's no
 * session_id to key the record on — nothing meaningful to record.
 */
export function buildCaptainSessionRecord(
  payload: unknown,
  project: string,
  fallbackCwd: string,
  now: string,
): CaptainSessionRecord | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { session_id?: unknown; cwd?: unknown; transcript_path?: unknown };

  const sessionId = typeof p.session_id === "string" && p.session_id ? p.session_id : null;
  if (!sessionId) return null;

  const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : fallbackCwd;
  const transcriptPath =
    (typeof p.transcript_path === "string" && p.transcript_path ? p.transcript_path : null) ??
    deriveTranscriptPath(sessionId, cwd) ??
    "";

  return { sessionId, project, agent: "claude", startedAt: now, cwd, transcriptPath };
}

/**
 * I/O: resolve the current project (cwd-based, same as `squadrant dispatch`)
 * and append a session record to that project's registry. Best-effort —
 * never throws, never blocks the hook contract (exit 0 either way).
 */
function recordCaptainSessionStart(payload: unknown): void {
  try {
    const config = loadConfig();
    const project = resolveCurrentProject(config);
    if (!project) return;
    const proj = config.projects[project];
    if (!proj) return;

    const record = buildCaptainSessionRecord(payload, project, process.cwd(), new Date().toISOString());
    if (!record) return;

    appendCaptainSession(proj.spokeVault, record);
  } catch {
    // Best-effort — a registry-write failure must never block the session.
  }
}

export function hooksCommand(): Command {
  const hooks = new Command("hooks")
    .description("(internal) receive lifecycle hook events from agent processes");

  hooks
    .command("claude <sub>", { hidden: true })
    .description("internal: bridge a NativeHookSource claude hook to squadrantd")
    .action(async (sub: string) => {
      // Read stdin FIRST — it's needed by both the captain path below and
      // the crew path further down, and a stream can only be drained once.
      let stdin = "";
      try {
        for await (const chunk of process.stdin) stdin += chunk as string;
      } catch { /* ignore */ }
      let payload: unknown = undefined;
      if (stdin.trim()) {
        try { payload = JSON.parse(stdin); } catch { /* ignore malformed */ }
      }

      // #651: captain sessions have SQUADRANT_ROLE=captain but no crew env
      // vars, so they'd otherwise no-op below without this. Best-effort,
      // side-effect-only — falls through to the same exit-0 hook contract.
      if (sub === "session-start" && process.env.SQUADRANT_ROLE === "captain") {
        recordCaptainSessionStart(payload);
      }

      const taskId = process.env.SQUADRANT_CREW_TASK_ID;
      const project = process.env.SQUADRANT_CREW_PROJECT;
      // Not a crew session — no-op (hook fires for all claude processes).
      if (!taskId || !project) { process.exit(0); }

      // #556: the broad ("" matcher) pre-tool-use hook fires for every tool
      // call, including Write/Edit — the only point that can see a crew's
      // file_path before it lands. Deny writes into the captain's long-term
      // memory directory; report/propose is the only allowed path there.
      if (sub === "pre-tool-use") {
        const p = payload as { tool_name?: unknown; tool_input?: unknown } | undefined;
        const guard = decideCaptainMemoryWrite(
          typeof p?.tool_name === "string" ? p.tool_name : "",
          p?.tool_input,
          process.env,
          homedir(),
        );
        if (guard.decision === "deny") {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: guard.reason,
            },
          }));
          process.exit(0);
        }
      }

      const ev = mapHookSub(sub, payload, taskId);
      if (!ev) { process.exit(0); }

      try {
        await sendToSock({ kind: "event", project, event: ev });
      } catch {
        // Daemon down: do NOT block claude. Hook contract requires exit 0.
      }
      process.exit(0);
    });

  return hooks;
}
