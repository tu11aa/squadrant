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
 *  - "error": the pane shows a fatal CLI error banner (e.g. Anthropic
 *    `API Error: 529 Overloaded`, an HTTP 5xx, retry exhaustion). A turn that
 *    dies on a transient API error leaves the process ALIVE with the banner
 *    frozen in the pane and no further heartbeat — the probe's only window onto
 *    it (#196). text = the banner line. Checked LAST so a genuine approval /
 *    question that merely mentions an error stays recoverable, never terminal.
 *  - else null.
 *
 * Conservative by design: it only runs against a quiet working pane and must not
 * false-block, so an ambiguous tail returns null.
 */
export function classifyPaneTail(
  tail: string,
): { kind: "approval" | "question" | "error"; text: string } | null {
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

  // ── generic picker: opencode's multi-option widget (no Yes/No) ───────────
  // The question is buried mid-paragraph; the picker footer ("↑↓ select …")
  // is the last content line, so detectTrailingQuestion never fires for it.
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

  // ── question: trailing question in the chrome-stripped agent output region ──
  const region = cleaned.filter((c): c is string => c != null).join("\n");
  const q = detectTrailingQuestion(region);
  if (q) return { kind: "question", text: q };

  // ── error: a fatal CLI error banner (#196), checked LAST so a recoverable
  // approval/question above always wins. Match the LAST banner line (the final
  // error after any retry chatter is the most informative).
  // #459: suppress the error verdict when the tail shows an active retry in
  // flight (e.g. "Retrying in 0s · attempt 1/10") but no exhaustion marker —
  // Claude Code auto-retries up to 10× and the crew usually recovers.
  let errLine: string | null = null;
  for (const c of cleaned) {
    if (c != null && ERROR_BANNER_RE.some((re) => re.test(c))) errLine = c;
  }
  if (errLine) {
    const isRetrying = cleaned.some((c) => c != null && RETRYING_RE.test(c));
    const isExhausted = cleaned.some((c) => c != null && EXHAUSTED_RE.test(c));
    if (isRetrying && !isExhausted) return null;
    return { kind: "error", text: errLine.slice(0, 200) };
  }

  return null;
}

// Distinctive fatal-error-banner signatures a crew's CLI prints when a turn
// dies (Anthropic / OpenAI / opencode). Anchored to CLI banner SHAPES — never a
// bare "error" / lone status code — so a crew merely discussing errors in prose
// is never mis-failed. Combined with the probe's working+quiet precondition,
// these only fire on a genuinely stalled, error-frozen pane.
const ERROR_BANNER_RE: RegExp[] = [
  /\bAPI Error\b/i,                                    // Claude: "API Error: 529 ..."
  /\bOverloaded\b/,                                    // Anthropic overloaded_error message
  /\b(?:429|500|502|503|504|529)\b[^?]*\b(?:overloaded|unavailable|internal server error|bad gateway|gateway timeout|too many requests|service unavailable)\b/i,
  /\bretr(?:y|ies)\s+(?:exhausted|limit\s+(?:reached|exceeded))\b/i,
  /\bmaximum\s+retries\b/i,
];

// Active-retry indicator: the CLI is still retrying (not yet exhausted). Used
// to suppress a false-fatal-error verdict for in-flight retries (#459).
const RETRYING_RE = /\bRetrying\b|\battempt\s+\d+\s*\/\s*\d+/i;

// Retry exhaustion: the final retry failed. When present alongside RETRYING_RE,
// exhaustion wins and the error verdict is still emitted.
const EXHAUSTED_RE = /\bretr(?:y|ies)\s+(?:exhausted|limit\s+(?:reached|exceeded))\b|\bmaximum\s+retries\b/i;

// A numbered option line, after chrome stripping: an optional cursor marker
// (❯ / > / ›), a number, a dot, then the label. e.g. "❯ 1. Yes".
const OPTION_RE = /^[❯>›]?\s*(\d+)\.\s+(.*\S)\s*$/;

// Footer navigation hint line rendered by opencode's interactive picker widget.
// The last content line of the picker box is the keyboard-shortcut legend.
const PICKER_FOOTER_RE = /↑↓\s*select|enter\s+submit|esc\s+dismiss/i;

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
