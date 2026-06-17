import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InteractiveHookAdapter } from "./types.js";
import type { ControlEvent } from "@cockpit/shared";

// PostToolUse fires after EVERY tool call mid-turn — it is the only liveness
// signal that refreshes the heartbeat while a crew is still working.
// Stop fires at turn completion and maps to task.turn.completed so the task
// transitions to awaiting-input (immune to stall detection) — without this,
// a captain AFK for >heartbeatBudgetMs would get a false CREW STALLED.
// SubagentStop fires only at a turn boundary but is liveness-only — it fires
// while the parent agent still owns the turn. SessionEnd is NOT liveness: it
// signals the session is gone (crash / Ctrl-C / /exit), so it terminalizes the
// record (→ task.session.ended) rather than resuming 'working' (#139).
const EVENTS = ["Stop", "SubagentStop", "SessionEnd", "PostToolUse", "Notification"] as const;

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

/**
 * Pure: returns true when a Notification hook message indicates Claude is waiting
 * for the user to grant a tool-use permission. Idle notifications ("Waiting for
 * your input", "Claude is thinking") return false — only permission/approval
 * language triggers the fast-path task.blocked path.
 */
export function isPermissionNotification(message: string): boolean {
  if (!message || !message.trim()) return false;
  const lower = message.toLowerCase();
  return lower.includes("permission") || lower.includes("approve");
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
 * Pure: derive the Claude transcript JSONL path for a session. Claude stores
 * transcripts at ~/.claude/projects/<escaped-cwd>/<session_id>.jsonl, where the
 * cwd is escaped by replacing every non-alphanumeric char with "-" (verified
 * against the live ~/.claude/projects layout — e.g. /Users/q3labsadmin/.claude-mem
 * -> -Users-q3labsadmin--claude-mem). Returns null if sessionId or cwd is missing.
 * This is the layered fallback for #174 when the Stop payload omits transcript_path.
 */
export function deriveTranscriptPath(sessionId: string, cwd: string): string | null {
  if (!sessionId || !cwd) return null;
  const escaped = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".claude", "projects", escaped, `${sessionId}.jsonl`);
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
 * I/O: obtain the last-assistant text from a LAYERED source, first hit wins:
 *   0. payload.last_assistant_message — the field Claude puts the final assistant
 *      text in DIRECTLY on the Stop payload (verified against claude-cli 2.1.156:
 *      carries the full final message, including a trailing question, no I/O). This
 *      is the primary source and the real #174 delivery fix — earlier diagnoses
 *      chased transcript_path (which can be absent), but the message is right here.
 *   1. else payload.transcript_path (documented field, when present + readable);
 *   2. else the path derived from payload.session_id + cwd (defensive fallback for
 *      older clients that omit both of the above).
 * cwd preference: payload.cwd (Claude hook contract) → COCKPIT_CREW_CWD → cwd().
 * Best-effort: a null/miss from one source falls through to the next; never throws.
 */
function resolveLastAssistantText(payload: unknown): string | null {
  const p = payload as any;
  const direct = p?.last_assistant_message;
  if (typeof direct === "string" && direct.trim()) return direct;
  const candidates: string[] = [];
  const tp = p?.transcript_path;
  if (typeof tp === "string" && tp) candidates.push(tp);
  const cwd = (typeof p?.cwd === "string" && p.cwd) ? p.cwd : (process.env.COCKPIT_CREW_CWD || process.cwd());
  const derived = deriveTranscriptPath(p?.session_id, cwd);
  if (derived) candidates.push(derived);
  for (const path of candidates) {
    const text = readLastAssistantText(path);
    if (text != null) return text;
  }
  return null;
}

/**
 * Map a Claude hook event name to a cockpit ControlEvent. Codifies the anti-#2576
 * invariant: NO Claude hook ever maps to `task.done`/`task.failed`.
 * PostToolUse/SubagentStop = resume-liveness only (task.progress). SessionEnd is
 * the lone terminalizing hook: the session is gone, so it maps to
 * task.session.ended → cancelled (#139) — silent, never done/failed.
 * Terminal `done`/`failed` come exclusively from explicit `cockpit crew signal`.
 *
 * Stop = turn boundary. It normally maps to task.turn.completed → awaiting-input
 * (stall-immune) so a captain reviewing output never trips a false CREW STALLED
 * (fixes #131). NARROW EXCEPTION #1 (#174): when the crew's last assistant message
 * ENDS with a direct question, Stop maps to task.blocked instead, surfacing the
 * question to the captain as CREW BLOCKED. The last-assistant text is obtained from
 * a LAYERED source (last_assistant_message on the payload → transcript_path →
 * derived path from session_id+cwd); the payload field is the primary, I/O-free
 * source. All transcript I/O is best-effort and never throws (hook must exit 0).
 *
 * Notification = Claude needs user attention. NARROW EXCEPTION #2
 * (#notification-hook): when the payload.message indicates a permission request
 * (isPermissionNotification), this maps to task.blocked instantly — bypassing the
 * ~20-30s relay poll. The relay poll remains as a fallback for opencode crews and
 * as a safety net; both may fire task.blocked for the same prompt, but the
 * state-machine idempotency (already-blocked → no-op, from #176) deduplicates.
 * Non-permission notifications (idle liveness) → task.progress. Missing/non-string
 * message → task.progress (never throws, hook must exit 0).
 */
export function mapClaudeHookToEvent(
  event: string,
  payload: unknown,
  taskId: string,
): ControlEvent | null {
  switch (event) {
    case "Stop": {
      const text = resolveLastAssistantText(payload);
      const question = text ? detectTrailingQuestion(text) : null;
      if (question) {
        return { type: "task.blocked", id: taskId, reason: "crew asked a question (auto-detected)", question };
      }
      return { type: "task.turn.completed", id: taskId, turnId: "hook-stop" };
    }
    case "Notification": {
      const msg = (payload as any)?.message;
      if (typeof msg === "string" && isPermissionNotification(msg)) {
        return { type: "task.blocked", id: taskId, reason: "crew awaiting permission (notification hook)", question: msg };
      }
      return { type: "task.progress", id: taskId, note: "notification" };
    }
    case "SessionEnd":
      // #139: the session is GONE. NOT liveness — mapping this to task.progress
      // resumed a dead crew to 'working' (awaiting-input → working), where
      // nothing heartbeats and the watchdog false-stalled it ~budget later.
      // Terminalize the record instead (reducer: task.session.ended → cancelled).
      return { type: "task.session.ended", id: taskId };
    case "SubagentStop":
    case "PostToolUse":
      // The only resume-liveness hooks: PostToolUse fires after every tool call
      // mid-turn; SubagentStop fires while the parent still owns the turn.
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
