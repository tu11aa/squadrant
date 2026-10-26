// A cmux agent-hook frame carries the emitting session's cwd and id. cwd alone is not ownership:
// a captain (or any session) whose Bash cd's into a crew worktree reports that worktree as its cwd,
// and its PreToolUse then opened a stale pendingTool on the crew's task (#1051 follow-up).
import { readClaudeStatusBySocketPath } from "@squadrant/agents";
import { TERMINAL_STATES } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";

/** cmux frames carry `cmux-feed-v1:<b64 agent>:<b64 session id>`; a bare id is taken as-is. */
export function decodeCmuxSessionId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /^cmux-feed-v1:[^:]*:(.+)$/.exec(raw);
  if (!m) return raw;
  const id = Buffer.from(m[1], "base64").toString("utf8");
  return id || undefined;
}

/**
 * The live interactive task a hook frame belongs to. With a session id the task must own that
 * session (its recorded sessionId, else the peer registry entry keyed by the socket squadrant
 * chose at launch) — a task whose session can't be resolved is not matched. Only a frame with no
 * session id at all falls back to cwd (none seen in live cmux hook frames).
 */
export function resolveHookTask(
  tasks: TaskRecord[],
  hook: { cwd?: string; sessionId?: string },
  sessionOf: (t: TaskRecord) => string | undefined = defaultSessionOf,
): TaskRecord | undefined {
  if (!hook.cwd) return undefined;
  const candidates = tasks.filter((r) => r.mode === "interactive" && !TERMINAL_STATES.has(r.state) && r.cwd === hook.cwd);
  const want = decodeCmuxSessionId(hook.sessionId);
  if (!want) return candidates[0];
  return candidates.find((r) => sessionOf(r) === want);
}

function defaultSessionOf(t: TaskRecord): string | undefined {
  return t.sessionId ?? (t.messagingSocketPath ? readClaudeStatusBySocketPath(t.messagingSocketPath)?.sessionId : undefined);
}
