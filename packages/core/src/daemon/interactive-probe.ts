// Daemon interactive-block probe: moved from commands/notify-relay.ts so
// daemon/probes.ts (core) can import it without a core→commands back-edge.
import type { TaskRecord, ControlEvent } from "@squadrant/shared";

// Entries older than this at session-start time are silently acked without
// delivery — stale events from a prior session or dead crews.
export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// A working interactive task with no heartbeat for this long is a probe
// candidate: PostToolUse never fires while a permission prompt is up.
export const PROBE_QUIET_MS = 20_000;

// ── Pure pane classifiers (inlined from interactive/pane-classifier.ts) ──────
// Duplication is intentional: pane-classifier.ts stays in root for the relay
// path; core can't import it (root → core boundary). Both copies are pure and
// covered by pane-classifier.test.ts.

function detectTrailingQuestion(text: string): string | null {
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

const ERROR_BANNER_RE: RegExp[] = [
  /\bAPI Error\b/i,
  /\bOverloaded\b/,
  /\b(?:429|500|502|503|504|529)\b[^?]*\b(?:overloaded|unavailable|internal server error|bad gateway|gateway timeout|too many requests|service unavailable)\b/i,
  /\bretr(?:y|ies)\s+(?:exhausted|limit\s+(?:reached|exceeded))\b/i,
  /\bmaximum\s+retries\b/i,
];
const OPTION_RE = /^[❯>›]?\s*(\d+)\.\s+(.*\S)\s*$/;
const PICKER_FOOTER_RE = /↑↓\s*select|enter\s+submit|esc\s+dismiss/i;
const PURE_CHROME_RE = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬▁▂▃▄▅▆▇█▔▏▕]+$/;
const STATUS_LINE_RE = /accept edits on|shift\+tab|⏵⏵|\? for shortcuts|esc to interrupt|tokens? (used|left)|context left/i;

function stripChrome(raw: string): string | null {
  let line = raw.replace(/\[[0-9;]*m/g, "");
  line = line.replace(/^[\s│┃▏▕|]+/, "").replace(/[\s│┃▏▕|]+$/, "");
  const trimmed = line.trim();
  if (trimmed === "") return null;
  if (PURE_CHROME_RE.test(trimmed)) return null;
  if (/^>\s*$/.test(trimmed)) return null;
  if (STATUS_LINE_RE.test(trimmed)) return null;
  return trimmed;
}

function classifyPaneTail(
  tail: string,
): { kind: "approval" | "question" | "error"; text: string } | null {
  if (!tail) return null;
  const raw = tail.split(/\r?\n/);
  const cleaned = raw.map(stripChrome);
  const options: { label: string; ci: number }[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c == null) continue;
    const m = c.match(OPTION_RE);
    if (m) options.push({ label: m[2], ci: i });
  }
  const hasYes = options.some((o) => /\byes\b/i.test(o.label));
  const hasNo = options.some((o) => /\bno\b/i.test(o.label));
  if (options.length >= 2 && hasYes && hasNo) {
    const firstOptCi = options[0].ci;
    for (let i = firstOptCi - 1; i >= 0; i--) {
      const c = cleaned[i];
      if (c == null) continue;
      if (c.endsWith("?")) return { kind: "approval", text: c };
    }
    return { kind: "approval", text: "Crew is awaiting permission approval." };
  }
  const hasPickerFooter = cleaned.some((c) => c != null && PICKER_FOOTER_RE.test(c));
  if (options.length >= 2 && hasPickerFooter) {
    const firstOptCi = options[0].ci;
    for (let i = firstOptCi - 1; i >= 0; i--) {
      const c = cleaned[i];
      if (c == null) continue;
      if (c.endsWith("?")) return { kind: "question", text: c };
    }
    return { kind: "question", text: "Crew is awaiting a choice." };
  }
  const region = cleaned.filter((c): c is string => c != null).join("\n");
  const q = detectTrailingQuestion(region);
  if (q) return { kind: "question", text: q };
  let errLine: string | null = null;
  for (const c of cleaned) {
    if (c != null && ERROR_BANNER_RE.some((re) => re.test(c))) errLine = c;
  }
  if (errLine) return { kind: "error", text: errLine.slice(0, 200) };
  return null;
}

// ── Interactive probe ─────────────────────────────────────────────────────────

interface InteractiveProbeDeps {
  project: string;
  listTasks: () => Promise<TaskRecord[]>;
  readPaneTail: (rec: TaskRecord) => Promise<string | null>;
  sendEvent: (event: ControlEvent) => Promise<void>;
  now: () => number;
  log: (m: string) => void;
  quietMs?: number;
}

export function createInteractiveProbe(deps: InteractiveProbeDeps): {
  tick: () => Promise<void>;
} {
  const quietMs = deps.quietMs ?? PROBE_QUIET_MS;
  const lastTail = new Map<string, string>();

  async function tick(): Promise<void> {
    let tasks: TaskRecord[];
    try {
      tasks = await deps.listTasks();
    } catch (e) {
      deps.log(`probe listTasks failed: ${(e as Error).message}`);
      return;
    }
    const now = deps.now();
    for (const rec of tasks) {
      if (rec.mode !== "interactive") continue;
      if (rec.state !== "working") continue;
      if (!rec.name) continue;
      if (now - rec.lastHeartbeat <= quietMs) continue;

      let tail: string | null;
      try {
        tail = await deps.readPaneTail(rec);
      } catch (e) {
        deps.log(`probe read failed for ${rec.id}: ${(e as Error).message}`);
        continue;
      }
      if (!tail) continue;
      if (lastTail.get(rec.id) === tail) continue;
      lastTail.set(rec.id, tail);

      const verdict = classifyPaneTail(tail);
      if (!verdict) continue;
      const event: ControlEvent =
        verdict.kind === "error"
          ? {
              type: "task.failed",
              id: rec.id,
              error: `crew session error (pane-detected): ${verdict.text}`,
            }
          : {
              type: "task.blocked",
              id: rec.id,
              reason:
                verdict.kind === "approval"
                  ? "crew awaiting permission (pane-detected)"
                  : "crew asked a question (pane-detected)",
              question: verdict.text,
            };
      try {
        await deps.sendEvent(event);
        const label = verdict.kind === "error" ? "CREW FAILED" : "CREW BLOCKED";
        deps.log(`probe -> ${label} ${rec.name} (${verdict.kind})`);
      } catch (e) {
        deps.log(`probe sendEvent failed for ${rec.id}: ${(e as Error).message}`);
      }
    }
  }

  return { tick };
}
