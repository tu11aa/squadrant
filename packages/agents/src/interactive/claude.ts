import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InteractiveHookAdapter } from "./types.js";
import type { ControlEvent } from "@squadrant/shared";

// PostToolUse fires after EVERY tool call mid-turn — it is the only liveness
// signal that refreshes the heartbeat while a crew is still working.
// Stop fires at turn completion and maps to task.turn.completed so the task
// transitions to awaiting-input (immune to stall detection) — without this,
// a captain AFK for >heartbeatBudgetMs would get a false CREW STALLED.
// SubagentStop fires only at a turn boundary but is liveness-only — it fires
// while the parent agent still owns the turn. SessionEnd is NOT liveness: it
// signals the session is gone (crash / Ctrl-C / /exit), so it terminalizes the
// record (→ task.session.ended) rather than resuming 'working' (#139).
// UserPromptSubmit fires before Claude processes each prompt submission, including
// the first interactive turn — used as the authoritative first-turn confirmation
// signal (#470), replacing the screen-scrape {delivered} heuristic.
const EVENTS = ["Stop", "SubagentStop", "SessionEnd", "PostToolUse", "Notification", "UserPromptSubmit"] as const;

// #560: matcher-scoped hook entries beyond the broad EVENTS list above — fires
// only for the named tool, not every tool call. AskUserQuestion is CC's native
// interactive-prompt tool: PreToolUse fires the instant it opens (and blocks
// the turn awaiting a human selection), so this is the earliest possible signal
// that a crew is blocked on a question. Scoped to this one tool so it doesn't
// double the per-tool-call hook overhead PostToolUse already covers.
const MATCHED_EVENTS: ReadonlyArray<readonly [event: string, matcher: string]> = [
  ["PreToolUse", "AskUserQuestion"],
];

// #560: Claude's PreToolUse hook payload carries no native per-tool-call id
// (documented shape is session_id/cwd/tool_name/tool_input only — no
// tool_use_id), so there is no "real" requestId to forward. Seeded from
// Date.now() and incremented per call (this module runs fresh per hook
// invocation, so in practice each call gets Date.now() at that moment) so
// schedulePromotion's `${taskId}#${requestId}` dedup key never collides
// across successive AskUserQuestion prompts for the same crew, unlike a
// hardcoded 0 would.
let nextAskUserQuestionRequestId = Date.now();

/**
 * Probe whether the local Claude CLI supports `--settings <path>`. The
 * daemon-supervised crew path needs per-invocation settings to inject the
 * squadrant Stop hook without polluting the user's global `~/.claude/settings.json`
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

// Keyed on (event, matcher) — NOT command alone. An event can carry both a
// bare entry (matcher "", from EVENTS) and a matcher-scoped entry (from
// MATCHED_EVENTS) with the identical command string (only the matcher
// differs; Claude dispatches on matcher, not on the command text). Scanning
// ALL entries for the event regardless of matcher would make the
// matcher-scoped install look "already done" the moment a bare entry for the
// same event+command exists, and silently skip installing it — the same
// silent-drop failure mode this hook set exists to close (#560).
function installHookEntry(hooks: Record<string, unknown>, event: string, matcher: string, command: string): void {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  const entries = hooks[event] as unknown[];
  const already = entries.some(
    (m) => (m as any)?.matcher === matcher &&
      Array.isArray((m as any)?.hooks) &&
      (m as any).hooks.some((h: any) => typeof h?.command === "string" && h.command.includes(command)),
  );
  if (!already) {
    entries.push({ matcher, hooks: [{ type: "command", command, timeout: 10 }] });
  }
}

/** Pure, idempotent merge of squadrant hooks into a Claude settings object. */
export function mergeClaudeHooks(settings: any, hookCmd: string): any {
  const next = structuredClone(settings ?? {});
  next.hooks ??= {};
  for (const ev of EVENTS) {
    installHookEntry(next.hooks, ev, "", `${hookCmd} ${ev}`);
  }
  for (const [ev, matcher] of MATCHED_EVENTS) {
    installHookEntry(next.hooks, ev, matcher, `${hookCmd} ${ev}`);
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
 * cwd preference: payload.cwd (Claude hook contract) → SQUADRANT_CREW_CWD → cwd().
 * Best-effort: a null/miss from one source falls through to the next; never throws.
 */
function resolveLastAssistantText(payload: unknown): string | null {
  const p = payload as any;
  const direct = p?.last_assistant_message;
  if (typeof direct === "string" && direct.trim()) return direct;
  const candidates: string[] = [];
  const tp = p?.transcript_path;
  if (typeof tp === "string" && tp) candidates.push(tp);
  const cwd = (typeof p?.cwd === "string" && p.cwd) ? p.cwd : (process.env.SQUADRANT_CREW_CWD || process.cwd());
  const derived = deriveTranscriptPath(p?.session_id, cwd);
  if (derived) candidates.push(derived);
  for (const path of candidates) {
    const text = readLastAssistantText(path);
    if (text != null) return text;
  }
  return null;
}

/**
 * Pure: render an AskUserQuestion tool call's `tool_input` (the raw arguments
 * Claude passes to the tool — `{ questions: [{ question, header, options,
 * multiSelect }] }`) into a human-readable prompt for CREW BLOCKED, carrying
 * both the question text AND its options (#560's proposal explicitly asks for
 * both — an option-less "awaiting input" placeholder can't be answered by
 * #562's answer channel or checked for staleness by #563).
 * Never throws; returns null when the shape doesn't match (caller must still
 * surface SOME text — see mapClaudeHookToEvent's PreToolUse case).
 */
export function formatAskUserQuestionPrompt(toolInput: unknown): string | null {
  const questions = (toolInput as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const parts: string[] = [];
  for (const q of questions) {
    if (!q || typeof q !== "object") continue;
    const text = (q as any).question;
    if (typeof text !== "string" || !text.trim()) continue;
    const options = Array.isArray((q as any).options) ? (q as any).options : [];
    const labels = options
      .map((o: any) => (o && typeof o.label === "string" ? o.label.trim() : null))
      .filter((l: string | null): l is string => !!l);
    parts.push(labels.length > 0 ? `${text.trim()} (options: ${labels.join(", ")})` : text.trim());
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}

/**
 * Map a Claude hook event name to a squadrant ControlEvent. Codifies the anti-#2576
 * invariant: NO Claude hook ever maps to `task.done`/`task.failed`.
 * PostToolUse/SubagentStop = resume-liveness only (task.progress). SessionEnd is
 * the lone terminalizing hook: the session is gone, so it maps to
 * task.session.ended → cancelled (#139) — silent, never done/failed.
 * Terminal `done`/`failed` come exclusively from explicit `squadrant crew signal`.
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
 *
 * PreToolUse = matcher-scoped to AskUserQuestion only (#560): the crew's own
 * hook set registers this ONLY for that tool (see MATCHED_EVENTS above), so in
 * practice tool_name is always "AskUserQuestion" here. Still checked
 * defensively — a config regression to a bare/unmatched PreToolUse must not
 * silently start reporting task.input.requested for every tool call. When it
 * IS AskUserQuestion, this maps to task.input.requested (NOT task.blocked —
 * task.blocked has no requestId field, and requestId is what
 * ctx.schedulePromotion in squadrantd.ts keys its answer-routing timer on;
 * task.input.requested already drives state-machine.ts → state 'blocked',
 * the CREW BLOCKED notification, and Telegram formatting) UNCONDITIONALLY —
 * even a malformed/unreadable tool_input still produces a generic fallback
 * question rather than falling through to null, because a detection path
 * that can silently fail to fire is the exact defect #560 exists to close.
 */
export function mapClaudeHookToEvent(
  event: string,
  payload: unknown,
  taskId: string,
): ControlEvent | null {
  switch (event) {
    case "PreToolUse": {
      const toolName = (payload as any)?.tool_name;
      if (toolName !== "AskUserQuestion") return null;
      const question = formatAskUserQuestionPrompt((payload as any)?.tool_input)
        ?? "crew opened an AskUserQuestion prompt (options unavailable)";
      return { type: "task.input.requested", id: taskId, requestId: nextAskUserQuestionRequestId++, question };
    }
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
    case "UserPromptSubmit":
      // #470: fires before Claude processes each prompt, including the first.
      // The reducer stamps firstTurnConfirmedAt only on the first occurrence;
      // subsequent submits (captain crew send follow-ups) are treated as liveness.
      return { type: "task.first-turn.confirmed", id: taskId };
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
