import { detectTrailingQuestion } from "./claude.js";

/**
 * Pure classifier for a crew pane's TAIL (last ~25 lines), used by the daemon's
 * fast interactive-prompt probe (Phase 2b). A crew blocked at a permission
 * prompt shows daemon state=working with NO heartbeat — the hook bridge only
 * fires PostToolUse, which never happens while the prompt is up — so the daemon
 * cannot see the block until the multi-minute stall budget. This detector lets
 * the probe surface that wait as CREW BLOCKED within one probe cadence.
 *
 *  - "approval": a permission-dialog shape — a "Do you want to ...?" prompt line
 *    plus a numbered Yes/No option block. text = the human-readable prompt line.
 *  - "question": the agent's output region (TUI chrome stripped) ends in a
 *    direct question. Mainly the opencode path; Claude turn-end questions are
 *    already handled by the #174 Stop-hook transcript path.
 *  - else null.
 *
 * Conservative by design: it only runs against a quiet working pane and must not
 * false-block, so an ambiguous tail returns null.
 */
export function classifyPaneTail(tail: string): { kind: "approval" | "question"; text: string } | null {
  if (!tail) return null;
  const raw = tail.split(/\r?\n/);
  // cleaned[i] is the agent-region text of line i, or null if the line is pure
  // TUI chrome (box border, empty input prompt, status line) and should be ignored.
  const cleaned = raw.map(stripChrome);

  // ── approval: numbered Yes/No option block + a "?"-terminated prompt above ──
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
    // The prompt is the nearest "?"-terminated agent line above the first option.
    const firstOptCi = options[0].ci;
    for (let i = firstOptCi - 1; i >= 0; i--) {
      const c = cleaned[i];
      if (c == null) continue;
      if (c.endsWith("?")) return { kind: "approval", text: c };
    }
    // Unmistakable Yes/No dialog but no "?"-line extracted → still actionable.
    return { kind: "approval", text: "Crew is awaiting permission approval." };
  }

  // ── question: trailing question in the chrome-stripped agent output region ──
  const region = cleaned.filter((c): c is string => c != null).join("\n");
  const q = detectTrailingQuestion(region);
  if (q) return { kind: "question", text: q };

  return null;
}

// A numbered option line, after chrome stripping: an optional cursor marker
// (❯ / > / ›), a number, a dot, then the label. e.g. "❯ 1. Yes".
const OPTION_RE = /^[❯>›]?\s*(\d+)\.\s+(.*\S)\s*$/;

// Box-drawing / rule characters that make up a pure-chrome line.
const PURE_CHROME_RE = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬▁▂▃▄▅▆▇█▔▏▕]+$/;
const STATUS_LINE_RE = /accept edits on|shift\+tab|⏵⏵|\? for shortcuts|esc to interrupt|tokens? (used|left)|context left/i;

/**
 * Strip the box-drawing border / cursor padding from one pane line and decide
 * whether it carries agent content. Returns the trimmed content, or null if the
 * line is pure TUI chrome (border, empty input prompt, status line) that the
 * classifier must ignore.
 */
function stripChrome(raw: string): string | null {
  // Defensive ANSI strip — cmux read-screen is usually plain text, but a stray
  // escape would otherwise leak into the extracted prompt text.
  let line = raw.replace(/\[[0-9;]*m/g, "");
  // Peel leading/trailing vertical box borders and surrounding whitespace.
  line = line.replace(/^[\s│┃▏▕|]+/, "").replace(/[\s│┃▏▕|]+$/, "");
  const trimmed = line.trim();
  if (trimmed === "") return null;
  if (PURE_CHROME_RE.test(trimmed)) return null;
  if (/^>\s*$/.test(trimmed)) return null; // empty input prompt
  if (STATUS_LINE_RE.test(trimmed)) return null;
  return trimmed;
}
