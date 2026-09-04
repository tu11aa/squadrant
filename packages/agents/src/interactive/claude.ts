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
// PermissionRequest fires while a tool-use permission dialog is open — earlier
// (~6s) and richer (tool_name + tool_input) than the matching Notification (#760).
const EVENTS = ["Stop", "SubagentStop", "SessionEnd", "PostToolUse", "Notification", "UserPromptSubmit", "PermissionRequest"] as const;

// #560: matcher-scoped hook entries beyond the broad EVENTS list above — fires
// only for the named tool, not every tool call. AskUserQuestion is CC's native
// interactive-prompt tool: PreToolUse fires the instant it opens (and blocks
// the turn awaiting a human selection), so this is the earliest possible signal
// that a crew is blocked on a question. Scoped to this one tool so it doesn't
// double the per-tool-call hook overhead PostToolUse already covers.
const MATCHED_EVENTS: ReadonlyArray<readonly [event: string, matcher: string]> = [
  ["PreToolUse", "AskUserQuestion"],
];

// #560/#760: neither Claude's PreToolUse (AskUserQuestion) nor Notification
// hook payload carries a native per-tool-call/per-notification id (documented
// shapes are session_id/cwd/tool_name/tool_input, and
// session_id/message/notification_type respectively — no tool_use_id), so
// there is no "real" requestId to forward for either. Seeded from Date.now()
// and incremented per call (this module runs fresh per hook invocation, so in
// practice each call gets Date.now() at that moment) so schedulePromotion's
// `${taskId}#${requestId}` dedup key never collides across successive prompts
// for the same crew, unlike a hardcoded 0 would. Shared by both call sites
// below (AskUserQuestion PreToolUse and Notification agent_needs_input).
let nextHookRequestId = Date.now();

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

/** Pure result of the captain-memory write guard (#556). */
export interface MemoryWriteGuardResult {
  decision: "deny" | "allow";
  reason?: string;
}

// #556: a crew wrote a materially wrong memory into its captain's long-term
// memory (~/.claude/projects/<encoded-cwd>/memory/{MEMORY.md,*.md}) and nothing
// flagged it — memory is loaded into every future session, so a wrong entry
// teaches the same mistake forever. Rule: crews REPORT, captains DECIDE what's
// durable. Path-shaped, not content-shaped — matches on the memory directory
// regardless of which file inside it a crew targets, or which tool it goes
// through (best-effort for Bash, since a shell command's target path is just
// text, not a resolvable field).
const CAPTAIN_MEMORY_PATH_RE = /\.claude\/projects\/.*\/memory\//;

const DENY_REASON =
  "Crews do not write captain memory. Put the finding in your done/blocked message; the captain decides what is durable (#556).";

// Tool → tool_input field that carries the target file path. MultiEdit shares
// Edit's file_path; NotebookEdit uses its own notebook_path.
const FILE_PATH_FIELD_BY_TOOL: Readonly<Record<string, string>> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/**
 * Pure: decide whether a crew's tool call must be denied for targeting a
 * captain's long-term memory directory. Takes exactly what a PreToolUse hook
 * payload + process env provide — no I/O — so the rule is unit-testable
 * without spawning claude. Only applies inside a crew session
 * (`SQUADRANT_CREW_TASK_ID` set); captain/command sessions write their own
 * memory freely.
 *
 * Write/Edit/MultiEdit/NotebookEdit are checked against their resolved target
 * path (must live under `homeDir`). Bash is checked with a best-effort string
 * match against its raw command text — a crew piping `cat >>` or `echo` into
 * a memory file never touches a structured file-path field.
 */
export function decideCaptainMemoryWrite(
  toolName: string,
  toolInput: unknown,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): MemoryWriteGuardResult {
  if (!env.SQUADRANT_CREW_TASK_ID) return { decision: "allow" };

  if (toolName === "Bash") {
    const command = (toolInput as { command?: unknown } | null | undefined)?.command;
    if (typeof command === "string" && CAPTAIN_MEMORY_PATH_RE.test(command)) {
      return { decision: "deny", reason: DENY_REASON };
    }
    return { decision: "allow" };
  }

  const field = FILE_PATH_FIELD_BY_TOOL[toolName];
  if (!field) return { decision: "allow" };
  const filePath = (toolInput as Record<string, unknown> | null | undefined)?.[field];
  if (typeof filePath !== "string" || !filePath) return { decision: "allow" };
  const home = homeDir.endsWith("/") ? homeDir.slice(0, -1) : homeDir;
  if (!filePath.startsWith(home)) return { decision: "allow" };
  if (!CAPTAIN_MEMORY_PATH_RE.test(filePath)) return { decision: "allow" };
  return { decision: "deny", reason: DENY_REASON };
}

/**
 * Pure: resolve the real per-turn correlation id. Stop/PermissionRequest/
 * Notification payloads all carry prompt_id (a UUID that matches across
 * events of the same turn — verified live, 2026-09-04 compat study §8.3).
 * Falls back to the pre-#761 constant when absent (older Claude clients).
 */
export function resolveTurnId(payload: unknown): string {
  const id = (payload as { prompt_id?: unknown } | null | undefined)?.prompt_id;
  return typeof id === "string" && id.trim() ? id : "hook-stop";
}

// #761: log-only observability for a crew that silently switched permission
// mode mid-session (cmux #8070 persists this as lastPermissionMode). No
// behaviour change — this never affects the emitted ControlEvent.
function logStopPermissionMode(payload: unknown, taskId: string): void {
  const mode = (payload as { permission_mode?: unknown } | null | undefined)?.permission_mode;
  if (typeof mode === "string" && mode) {
    console.error(`[squadrant] hook: Stop permission_mode=${mode} task=${taskId}`);
  }
}

/**
 * Pure: classify a Notification hook using the structured notification_type
 * field — REQUIRED (not optional) on current Claude clients, a 14-value enum
 * (verified live, 2026-09-04 compat study §8.1). The Notification hook is
 * matcher-scopable on this exact field, the same mechanism squadrant already
 * uses to scope PreToolUse to AskUserQuestion (#560) — this removes English
 * substring matching entirely for any client that sends it. Falls back to the
 * pre-#760 substring test (isPermissionNotification) ONLY when
 * notification_type is absent (older clients) — never for a recognized-but-
 * unmapped value on a current client.
 */
export function classifyNotification(
  payload: unknown,
): { kind: "blocked" | "input-requested" | "progress"; question?: string } {
  const p = payload as { message?: unknown; notification_type?: unknown } | null | undefined;
  const msg = typeof p?.message === "string" ? p.message : "";
  const notificationType = typeof p?.notification_type === "string" ? p.notification_type : null;

  if (notificationType === "permission_prompt" || notificationType === "worker_permission_prompt") {
    return { kind: "blocked", question: msg || "crew awaiting permission" };
  }
  if (notificationType === "agent_needs_input") {
    return { kind: "input-requested", question: msg || "crew needs input" };
  }
  if (notificationType != null) {
    // idle_prompt, quota_auto_resume_*, auth_success, agent_completed,
    // elicitation_*, push_notification, computer_use_* — liveness only.
    // squadrant has no dedicated source for quota/auth state yet (#760).
    return { kind: "progress" };
  }
  if (msg && isPermissionNotification(msg)) {
    return { kind: "blocked", question: msg };
  }
  return { kind: "progress" };
}

// Tool → tool_input field carrying a short, human-meaningful hint of WHAT is
// being asked (reuses the file-path map already defined for the captain-
// memory write guard, plus Bash's command). Never used to dump the full
// tool_input — only this one field, truncated — so a PermissionRequest
// question can never leak large file contents (hard rule, #760).
const TOOL_INPUT_HINT_LEN = 80;
function summarizeToolInput(toolName: unknown, toolInput: unknown): string {
  if (typeof toolName !== "string" || !toolName) return "a tool call";
  const input = toolInput as Record<string, unknown> | null | undefined;
  if (!input || typeof input !== "object") return toolName;
  const hintField = FILE_PATH_FIELD_BY_TOOL[toolName] ?? (toolName === "Bash" ? "command" : undefined);
  const raw = hintField ? input[hintField] : undefined;
  if (typeof raw === "string" && raw) {
    const short = raw.length > TOOL_INPUT_HINT_LEN ? `${raw.slice(0, TOOL_INPUT_HINT_LEN)}…` : raw;
    return `${toolName}(${short})`;
  }
  return toolName;
}

/**
 * Pure: build a task.blocked question for a PermissionRequest hook. Never
 * serializes the full tool_input (#760 hard rule) — only a short, tool-
 * specific hint via summarizeToolInput.
 */
export function formatPermissionRequestQuestion(payload: unknown): string {
  const p = payload as { tool_name?: unknown; tool_input?: unknown } | null | undefined;
  return `crew needs permission to run ${summarizeToolInput(p?.tool_name, p?.tool_input)}`;
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
 * Notification = Claude needs user attention. Classified via classifyNotification
 * (#760): notification_type in {permission_prompt, worker_permission_prompt} maps
 * to task.blocked instantly — bypassing the ~20-30s relay poll — and
 * agent_needs_input maps to task.input.requested. The relay poll remains as a
 * fallback for opencode crews and as a safety net; both may fire task.blocked for
 * the same prompt, but the state-machine idempotency (already-blocked → no-op,
 * from #176) deduplicates. All other notification_type values (idle_prompt,
 * quota_auto_resume_*, etc.) and payloads missing notification_type entirely
 * (older clients, falls back to the isPermissionNotification substring test) →
 * task.progress. Missing/non-string message → task.progress (never throws, hook
 * must exit 0).
 *
 * PermissionRequest = a dedicated, earlier (~6s before Notification), richer
 * permission signal (#760): tool_name + tool_input are present directly on the
 * payload, so the task.blocked question can say WHAT is being asked instead of
 * the generic Notification text. Always maps to task.blocked — dedup against a
 * same-prompt Notification is handled for free by the existing already-blocked
 * no-op in state-machine.ts. tool_input is NEVER serialized in full — only a
 * short, tool-specific hint (file path / Bash command, truncated).
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
      return { type: "task.input.requested", id: taskId, requestId: nextHookRequestId++, question };
    }
    case "Stop": {
      const text = resolveLastAssistantText(payload);
      const question = text ? detectTrailingQuestion(text) : null;
      if (question) {
        return { type: "task.blocked", id: taskId, reason: "crew asked a question (auto-detected)", question };
      }
      logStopPermissionMode(payload, taskId);
      return { type: "task.turn.completed", id: taskId, turnId: resolveTurnId(payload) };
    }
    case "Notification": {
      const cls = classifyNotification(payload);
      if (cls.kind === "blocked") {
        return { type: "task.blocked", id: taskId, reason: "crew awaiting permission (notification hook)", question: cls.question! };
      }
      if (cls.kind === "input-requested") {
        return { type: "task.input.requested", id: taskId, requestId: nextHookRequestId++, question: cls.question! };
      }
      return { type: "task.progress", id: taskId, note: "notification" };
    }
    case "PermissionRequest":
      // #760: fires ~6s before the matching Notification, with the tool name
      // and a rich (never fully dumped) input summary — a strictly better
      // task.blocked source. Re-blocking an already-blocked task is a no-op
      // in the reducer (task.blocked idempotency, #174), so this naturally
      // dedups against a Notification for the same prompt_id without extra
      // state here.
      return {
        type: "task.blocked",
        id: taskId,
        reason: "crew awaiting permission (permission-request hook)",
        question: formatPermissionRequestQuestion(payload),
      };
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
