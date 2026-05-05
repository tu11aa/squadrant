export type ScreenState = "idle" | "busy" | "blocked" | "errored" | "offline";

export interface ClassifyOptions {
  lines: number;        // window of trailing lines to inspect for state
  excerptLines: number; // window of trailing non-empty lines to keep as excerpt
}

export interface ClassifyResult {
  state: ScreenState;
  excerpt: string;
}

const OFFLINE_MARKERS = [
  /session ended/i,
  /\[process exited/i,
  /\[exited\b/i,
  /agent stopped/i,
];

const ERRORED_MARKERS = [
  /✗/,
  /\bpanic:/i,
  /\bFATAL\b/,
  /^error:\s/im,
  /\bTraceback \(most recent call last\)/,
];

const BLOCKED_MARKERS = [
  /\bblocked\b/i,
  /waiting for input/i,
  /needs input/i,
  /stuck on/i,
  /can'?t proceed/i,
];

// Spinner glyphs commonly emitted by Claude Code, Codex, Aider, npm/pnpm, cargo, etc.
const SPINNER_CHARS = ["✻", "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const BUSY_KEYWORDS = [
  /Cogitat/i,
  /Brewing/i,
  /Thinking/i,
  /\bRunning\b/i,
  /Compiling/i,
  /Installing/i,
  /Generating/i,
  /Searching/i,
];

function tailLines(text: string, n: number): string[] {
  const all = text.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - n));
}

function lastNonEmpty(lines: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const t = lines[i].replace(/\s+$/, "");
    if (t.trim().length > 0) out.unshift(t);
  }
  return out;
}

export function classifyScreen(text: string, opts: ClassifyOptions): ClassifyResult {
  const tail = tailLines(text, opts.lines);
  const excerptLines = lastNonEmpty(tail, opts.excerptLines);
  const excerpt = excerptLines.join("\n");

  if (excerpt.trim().length === 0) {
    return { state: "offline", excerpt: "" };
  }

  const tailJoined = tail.join("\n");

  if (OFFLINE_MARKERS.some((re) => re.test(tailJoined))) {
    return { state: "offline", excerpt };
  }

  if (ERRORED_MARKERS.some((re) => re.test(tailJoined))) {
    return { state: "errored", excerpt };
  }

  if (BLOCKED_MARKERS.some((re) => re.test(tailJoined))) {
    return { state: "blocked", excerpt };
  }

  const hasSpinnerChar = SPINNER_CHARS.some((c) => tailJoined.includes(c));
  if (hasSpinnerChar || BUSY_KEYWORDS.some((re) => re.test(tailJoined))) {
    return { state: "busy", excerpt };
  }

  return { state: "idle", excerpt };
}
