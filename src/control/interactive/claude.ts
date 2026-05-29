import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { InteractiveHookAdapter } from "./types.js";
import type { ControlEvent } from "../types.js";

// PostToolUse fires after EVERY tool call mid-turn — it is the only liveness
// signal that refreshes the heartbeat while a crew is still working.
// Stop fires at turn completion and maps to task.turn.completed so the task
// transitions to awaiting-input (immune to stall detection) — without this,
// a captain AFK for >heartbeatBudgetMs would get a false CREW STALLED.
// SubagentStop/SessionEnd fire only at turn boundaries but are liveness-only:
// SubagentStop fires while the parent agent still owns the turn, and SessionEnd
// is an unreliable signal (crash / Ctrl-C / /exit).
const EVENTS = ["Stop", "SubagentStop", "SessionEnd", "PostToolUse"] as const;

/**
 * Probe whether the local Claude CLI supports `--settings <path>`. The
 * daemon-supervised crew path needs per-invocation settings to inject the
 * cockpit Stop hook without polluting the user's global `~/.claude/settings.json`
 * (the scrapped PR #71 mistake). Returns "flag" when --settings is available
 * (the happy path), "project-dir" when the fallback (write `.claude/settings.json`
 * under the project dir + cd) is needed.
 */
export function probeClaudeSettingsFlag(): "flag" | "project-dir" {
  try {
    const help = execSync("claude --help", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return help.includes("--settings ") ? "flag" : "project-dir";
  } catch {
    return "project-dir";
  }
}

/** Pure, idempotent merge of cockpit hooks into a Claude settings object. */
export function mergeClaudeHooks(settings: any, hookCmd: string): any {
  const next = structuredClone(settings ?? {});
  next.hooks ??= {};
  for (const ev of EVENTS) {
    if (!Array.isArray(next.hooks[ev])) next.hooks[ev] = [];
    const already = next.hooks[ev].some((m: any) =>
      Array.isArray(m?.hooks) && m.hooks.some((h: any) => typeof h.command === "string" && h.command.includes(hookCmd)),
    );
    if (!already) {
      next.hooks[ev].push({ matcher: "", hooks: [{ type: "command", command: `${hookCmd} ${ev}`, timeout: 10 }] });
    }
  }
  return next;
}

/**
 * Pure, conservative detector for a trailing question that needs captain input.
 * Returns the question text when the LAST non-empty line of the message (outside
 * any fenced code block) ends with "?", else null. Intentionally narrow to avoid
 * false-blocked: rhetorical mid-text questions and questions inside ```fences```
 * are ignored because only the final visible line counts. When unsure → null.
 */
export function detectTrailingQuestion(text: string): string | null {
  if (!text) return null;
  let inFence = false;
  let lastLine: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence || line === "") continue;
    lastLine = line;
  }
  if (lastLine && lastLine.endsWith("?")) return lastLine;
  return null;
}

/**
 * I/O: read the LAST assistant message text from a Claude transcript JSONL file.
 * Kept separate from the pure detector so the detector stays trivially testable.
 * Never throws — returns null on any read/parse failure (the hook must exit 0).
 */
function readLastAssistantText(transcriptPath: string): string | null {
  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      const isAssistant = entry?.type === "assistant" || entry?.message?.role === "assistant";
      if (!isAssistant) continue;
      const content = entry?.message?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const txt = content
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("\n")
          .trim();
        return txt || null;
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Map a Claude hook event name to a cockpit ControlEvent. Codifies the anti-#2576
 * invariant: NO Claude hook ever maps to `task.done`/`task.failed`.
 * PostToolUse/SubagentStop/SessionEnd = liveness only (task.progress).
 * Terminal `done`/`failed` come exclusively from explicit `cockpit crew signal`.
 *
 * Stop = turn boundary. It normally maps to task.turn.completed → awaiting-input
 * (stall-immune) so a captain reviewing output never trips a false CREW STALLED
 * (fixes #131). NARROW EXCEPTION (#174): when the Stop payload carries a
 * `transcript_path` and the crew's last assistant message ENDS with a direct
 * question, Stop maps to task.blocked instead, surfacing the question to the
 * captain as CREW BLOCKED. This is the one auto-detected path to `task.blocked`;
 * it relaxes the old "no hook → blocked" rule for blocked ONLY (never done/failed).
 * All transcript I/O is best-effort: any failure falls back to task.turn.completed
 * and never throws (the hook must exit 0).
 */
export function mapClaudeHookToEvent(
  event: string,
  payload: unknown,
  taskId: string,
): ControlEvent | null {
  switch (event) {
    case "Stop": {
      const transcriptPath = (payload as any)?.transcript_path;
      if (typeof transcriptPath === "string" && transcriptPath) {
        const text = readLastAssistantText(transcriptPath);
        const question = text ? detectTrailingQuestion(text) : null;
        if (question) {
          return { type: "task.blocked", id: taskId, reason: "crew asked a question (auto-detected)", question };
        }
      }
      return { type: "task.turn.completed", id: taskId, turnId: "hook-stop" };
    }
    case "SubagentStop":
    case "SessionEnd":
    case "PostToolUse":
      return { type: "task.progress", id: taskId, note: event.toLowerCase() };
    default:
      return null;
  }
}

export const claudeInteractive: InteractiveHookAdapter = {
  provider: "claude",
  tier: "strong",
  injectHook(launchSpec) {
    // Claude reads merged ~/.config settings; nothing to add to argv here.
    // The settings merge is performed by the launcher (Task 18) before spawn.
    return launchSpec;
  },
};
