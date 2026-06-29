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
import { sendRequest } from "@squadrant/core";
import { mapClaudeHookToEvent } from "@squadrant/agents";
import type { ControlEvent } from "@squadrant/shared";

const SOCK = join(homedir(), ".config", "squadrant", "squadrant.sock");

async function sendToSock(req: unknown): Promise<void> {
  await sendRequest(SOCK, req);
}

/**
 * Map a NativeHookSource sub-alias to a ControlEvent.
 *
 * "stop", "notification", "session-end" delegate to mapClaudeHookToEvent (which
 * handles detectTrailingQuestion and isPermissionNotification). The new subs
 * not covered by the existing per-crew mapper are handled inline.
 */
function mapHookSub(sub: string, payload: unknown, taskId: string): ControlEvent | null {
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
    case "ask-question": {
      const q = typeof (payload as Record<string, unknown>)?.question === "string"
        ? (payload as Record<string, unknown>).question as string
        : "awaiting input";
      return { type: "task.input.requested", id: taskId, requestId: 0, question: q };
    }
    case "session-end":
      return mapClaudeHookToEvent("SessionEnd", payload, taskId);
    default:
      return null;
  }
}

export function hooksCommand(): Command {
  const hooks = new Command("hooks")
    .description("(internal) receive lifecycle hook events from agent processes");

  hooks
    .command("claude <sub>", { hidden: true })
    .description("internal: bridge a NativeHookSource claude hook to squadrantd")
    .action(async (sub: string) => {
      const taskId = process.env.SQUADRANT_CREW_TASK_ID;
      const project = process.env.SQUADRANT_CREW_PROJECT;
      // Not a crew session — no-op (hook fires for all claude processes).
      if (!taskId || !project) { process.exit(0); }

      let stdin = "";
      try {
        for await (const chunk of process.stdin) stdin += chunk as string;
      } catch { /* ignore */ }
      let payload: unknown = undefined;
      if (stdin.trim()) {
        try { payload = JSON.parse(stdin); } catch { /* ignore malformed */ }
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
