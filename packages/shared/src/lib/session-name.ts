// packages/shared/src/lib/session-name.ts
//
// #708: squadrant never passes claude's `-n, --name` flag, so every launched
// session's display name auto-derives from the cwd basename + a short suffix
// Claude Code appends — a crew became "squadrant-fix-706-67", a captain
// "helpa-06". A crew that called ListAgents could not tell which entry was
// its own captain and sent its report to an unrelated session instead.
//
// These builders produce self-describing names instead: role + project (+
// crew name, for crews). Sanitized to the same safe-filename charset
// captainSocketPath() already enforces, since these strings end up in
// Claude's on-disk session registry.

const UNSAFE_CHARS = /[^A-Za-z0-9._-]+/g;
const MAX_LEN = 80;

/** Collapse anything outside [A-Za-z0-9._-] to '-', trim edges, cap length. */
export function sanitizeSessionName(raw: string): string {
  return raw
    .replace(UNSAFE_CHARS, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LEN);
}

export function captainSessionName(project: string): string {
  return sanitizeSessionName(`squadrant-captain-${project}`);
}

export function crewSessionName(project: string, crewName: string): string {
  return sanitizeSessionName(`squadrant-crew-${project}-${crewName}`);
}
