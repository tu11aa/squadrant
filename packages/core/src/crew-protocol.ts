// Pure crew protocol and naming primitives — no I/O, no external-package deps.
// Extracted from packages/cli/src/commands/crew.ts so they are unit-testable
// and importable by packages other than cli.

/** Configuration for the post-send acceptance check that replaces a naive
 *  screen-changed comparison. For agents whose idle splash keeps mutating
 *  (opencode's "Ask anything…" with blinking cursor / status line), the old
 *  check would always see a different screen and never re-send a dropped turn. */
export interface TurnAcceptanceConfig {
  /** Text that identifies the idle splash state. When set, acceptance requires
   *  this marker to be absent from the screen (e.g. "Ask anything…" for opencode).
   *  Without it, acceptance defaults to "screen changed" (claude behavior). */
  splashMarker?: string;
  /** Max rounds of "wait, check, re-send" after the initial send. Defaults to 2
   *  (initial + 1 re-send) to match the pre-retry behavior for claude. Use 3 for
   *  opencode which has a wider boot-race window. */
  retryLimit?: number;
}

/** Normalizes screen/marker text for splash-marker matching: case-insensitive,
 *  whitespace-collapsed, and treats the single-char ellipsis (U+2026) and "..."
 *  interchangeably. opencode's idle-splash wording rotates through example
 *  prompts and has drifted in exact glyph/punctuation across versions (#499:
 *  the hardcoded "Ask anything…" (U+2026) never matched real "Ask anything..."
 *  (three ASCII dots) renders), so matching the literal string is unsafe —
 *  match a stable substring instead. */
function normalizeForSplashMatch(text: string): string {
  return text.toLowerCase().replace(/…/g, "...").replace(/\s+/g, " ").trim();
}

/** True when `marker` appears in `screen` under splash-match normalization. */
export function screenHasSplashMarker(screen: string, marker: string): boolean {
  return normalizeForSplashMatch(screen).includes(normalizeForSplashMatch(marker));
}

/** Pure-function decision: was the first turn accepted by the TUI?
 *  - With splashMarker: accepted = the marker is no longer visible (the TUI left
 *    its idle splash, confirming the keystroke was received).
 *  - Without splashMarker (claude): accepted = the screen changed after sending.
 *
 *  Callers on the splash path MUST additionally gate on having observed the
 *  splash marker at least once before trusting "marker absent" as acceptance
 *  (see crew-pane.ts's sawSplash latch) — a marker that never matches (drift,
 *  misconfiguration) would otherwise make this return true from the first
 *  check, before any keystroke lands (#499). */
export function isTurnAccepted(
  preSendScreen: string,
  afterScreen: string,
  config?: TurnAcceptanceConfig,
): boolean {
  if (config?.splashMarker) {
    return !screenHasSplashMarker(afterScreen, config.splashMarker);
  }
  return afterScreen !== preSendScreen;
}

/** Builds the completion-protocol suffix baked into claude + opencode first turns (#278).
 *  Substituting --task-id and --project at source makes the signal robust to env-var
 *  races (Mode 1) and gives the model a concrete imperative at the point of action (Mode 2).
 *
 *  WARNING: The exact output text is load-bearing — a single byte change silently
 *  breaks crew DONE. Any modification must be validated against the crew-lifecycle
 *  checklist CP-DONE checkpoint. A snapshot test guards against drift. */
export function buildCompletionProtocol(taskId: string, project: string): string {
  return [
    "---",
    "COMPLETION PROTOCOL (required): When this task is fully complete, your FINAL action MUST be to run exactly:",
    `  squadrant crew signal done --task-id ${taskId} --project ${project} --message "<one-line summary>"`,
    "Run it as a discrete final step AFTER you report your results. If you are blocked or need a decision, instead run:",
    `  squadrant crew signal blocked --task-id ${taskId} --project ${project} --question "<your question>"`,
    "If this task failed because of a defect in squadrant itself (not an API/infra blip, a config/user error, or an expected failure), say so in your signal done/blocked message so the captain can check tu11aa/squadrant and file it. Don't file issues from the crew.",
  ].join("\n");
}

// POSIX single-quote a path so it is safe to embed in a shell command even
// when the path contains spaces or special characters.
export function shellQuote(p: string): string {
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

export function titleFor(project: string, name: string): string {
  return `🔧 ${project}:${name}`;
}

export function isCrewTitle(project: string, title: string): boolean {
  return title.startsWith(`🔧 ${project}:`);
}

export function nameFromTitle(project: string, title: string): string {
  return title.slice(`🔧 ${project}:`.length);
}

export function nextAutoName(existingTitles: string[], project: string): string {
  const used = new Set<number>();
  for (const title of existingTitles) {
    const n = nameFromTitle(project, title).match(/^crew-(\d+)$/);
    if (n) used.add(Number(n[1]));
  }
  let i = 1;
  while (used.has(i)) i++;
  return `crew-${i}`;
}
