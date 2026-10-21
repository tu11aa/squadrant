import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * #1015 context meter. Live context size of one agent session, read from the
 * tail of its transcript — never the whole file, and cached by mtime so
 * polling is near-free.
 *
 * Claude only today: it is the one driver whose transcript carries per-call
 * `usage`. Codex/OpenCode meters return `unknown` (see `meterTask`) — an
 * honest value, not a guess. The line parser here is the single copy shared
 * with `squadrant tokens` (#626).
 */

export interface AssistantUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ParsedTranscriptLine {
  /** Raw ISO timestamp string from the line, if present — every line type
   *  (user, assistant, attachment, ...) carries one; only a handful of
   *  metadata-only line types (e.g. "mode", "queue-operation") omit it. */
  timestamp: string | null;
  usage: AssistantUsage | null;
  /** Anthropic message id of an assistant line (several lines can share one). */
  messageId: string | null;
  model: string | null;
}

/** Pure. Parse one raw JSONL transcript line into its timestamp and (if it's
 *  an assistant message with a usage block) usage numbers. User turns,
 *  tool-result lines, and unparsable lines get usage: null. */
export function parseTranscriptLine(rawLine: string): ParsedTranscriptLine {
  const none: ParsedTranscriptLine = { timestamp: null, usage: null, messageId: null, model: null };
  const line = rawLine.trim();
  if (!line) return none;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return none;
  }
  const entry = obj as {
    type?: string;
    timestamp?: string;
    message?: { id?: string; model?: string; role?: string; usage?: Record<string, number> };
  };
  const timestamp = typeof entry?.timestamp === "string" ? entry.timestamp : null;
  if (entry?.type !== "assistant" || entry.message?.role !== "assistant") return { ...none, timestamp };
  const usage = entry.message?.usage;
  if (!usage) return { ...none, timestamp };
  return {
    timestamp,
    messageId: typeof entry.message?.id === "string" ? entry.message.id : null,
    model: typeof entry.message?.model === "string" ? entry.message.model : null,
    usage: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/** Pure. Convenience wrapper over `parseTranscriptLine` for callers that only
 *  need the usage numbers (e.g. unit tests). */
export function parseAssistantUsage(rawLine: string): AssistantUsage | null {
  return parseTranscriptLine(rawLine).usage;
}

/** Pure. Mirrors Claude Code's own transcript-path escaping: every
 *  non-alphanumeric character in the cwd becomes "-". */
export function escapeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export interface ContextReading {
  /** Live context ≈ input + cache_read + cache_creation of the latest assistant call. */
  tokens: number;
  /** Only when the model name states it (e.g. a "[1m]" suffix); otherwise unknown. */
  windowTokens?: number;
  pct?: number;
  /** Epoch ms of the transcript's last write — when this reading was true. */
  measuredAt: number;
}

/** `unknown` is an honest value: no transcript, no usage yet, or an agent without a meter. */
export type ContextMeter = ContextReading | "unknown";

const TAIL_START_BYTES = 128 * 1024;
const TAIL_MAX_BYTES = 4 * 1024 * 1024;

/** Pure. Latest usable assistant call in `lines` (oldest→newest). Lines sharing
 *  a message id are one call (mirror/streamed block lines), and an all-zero
 *  usage (synthetic entries) carries no information — both are skipped. */
export function latestContextFromLines(lines: readonly string[]): { tokens: number; model: string | null } | null {
  const seen = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const { usage, messageId, model } = parseTranscriptLine(lines[i]);
    if (!usage) continue;
    if (messageId) {
      if (seen.has(messageId)) continue;
      seen.add(messageId);
    }
    const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
    if (tokens === 0) continue;
    return { tokens, model };
  }
  return null;
}

function windowFromModel(model: string | null): number | undefined {
  return model && /\[1m\]/i.test(model) ? 1_000_000 : undefined;
}

const cache = new Map<string, { mtimeMs: number; size: number; reading: ContextMeter }>();

/** Read the tail of a transcript, doubling the window until a usable call is
 *  found or TAIL_MAX_BYTES is hit. Never throws. */
export function readClaudeContext(transcriptPath: string): ContextMeter {
  let st: fs.Stats;
  try { st = fs.statSync(transcriptPath); } catch { return "unknown"; }
  const hit = cache.get(transcriptPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.reading;

  let reading: ContextMeter = "unknown";
  let fd: number | null = null;
  try {
    fd = fs.openSync(transcriptPath, "r");
    for (let want = TAIL_START_BYTES; ; want *= 2) {
      const len = Math.min(want, st.size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      let text = buf.toString("utf-8");
      // A tail read starts mid-line unless it covers the whole file: drop the partial first line.
      if (len < st.size) text = text.slice(text.indexOf("\n") + 1);
      const found = latestContextFromLines(text.split("\n"));
      if (found) {
        const windowTokens = windowFromModel(found.model);
        reading = {
          tokens: found.tokens,
          measuredAt: Math.round(st.mtimeMs),
          ...(windowTokens ? { windowTokens, pct: Math.round((found.tokens / windowTokens) * 100) } : {}),
        };
        break;
      }
      if (len >= st.size || want >= TAIL_MAX_BYTES) break;
    }
  } catch {
    reading = "unknown";
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
  }
  cache.set(transcriptPath, { mtimeMs: st.mtimeMs, size: st.size, reading });
  return reading;
}

/** Test seam. */
export function clearContextMeterCache(): void { cache.clear(); }

export interface MeterableTask {
  provider: string;
  sessionId?: string;
  cwd?: string;
  createdAt?: number;
}

/** A crew's transcript: `<projects>/<escaped cwd>/<sessionId>.jsonl` when the
 *  record carries the session id; otherwise the newest transcript written
 *  since the task was created in the crew's own worktree dir (one crew per
 *  worktree, so the dir identifies it). `projectsDir` is injectable for tests. */
export function crewTranscriptPath(task: MeterableTask, projectsDir: string = claudeProjectsDir()): string | null {
  if (!task.cwd) return null;
  const dir = path.join(projectsDir, escapeClaudeProjectPath(task.cwd));
  if (task.sessionId) {
    const p = path.join(dir, `${task.sessionId}.jsonl`);
    return fs.existsSync(p) ? p : null;
  }
  let best: { p: string; m: number } | null = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(dir, f);
      const m = fs.statSync(p).mtimeMs;
      if (m >= (task.createdAt ?? 0) && (!best || m > best.m)) best = { p, m };
    }
  } catch { return null; }
  return best?.p ?? null;
}

/** Meter a crew task. Claude reads its transcript; every other agent is
 *  `unknown` — opencode keeps tokens in its own session store and codex in its
 *  app-server thread, neither cheap or stable to read from here (#1015). */
export function meterTask(task: MeterableTask, projectsDir?: string): ContextMeter {
  if (task.provider !== "claude") return "unknown";
  const p = crewTranscriptPath(task, projectsDir);
  return p ? readClaudeContext(p) : "unknown";
}

/** "182k", "1.2M", "unknown". */
export function formatContext(m: ContextMeter | number): string {
  if (m === "unknown") return "unknown";
  const t = typeof m === "number" ? m : m.tokens;
  if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`;
  if (t >= 1000) return `${Math.round(t / 1000)}k`;
  return String(t);
}

export function contextTokens(m: ContextMeter): number | null {
  return m === "unknown" ? null : m.tokens;
}
