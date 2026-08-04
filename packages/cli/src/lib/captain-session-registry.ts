// captain-session-registry.ts — #651: ground-truth session attribution,
// recorded at the source instead of inferred after the fact. mtime-picking
// and content-sniffing for a role marker were both tried and both rejected:
// mtime-picking can select ANY session in the same project dir (including a
// human's plain, non-captain Claude session), and grepping transcript
// content for a marker is inference over a possibly-incomplete read, not
// ground truth. This file is the append-only registry itself; the hook that
// writes to it lives in commands/hooks.ts (SessionStart, captain role only).
import fs from "node:fs";
import path from "node:path";
import type { CaptainSessionRecord } from "./handoff-facts.js";
import { SESSION_WINDOW_MS } from "./handoff-facts.js";

export { SESSION_WINDOW_MS };
export const CAPTAIN_SESSION_REGISTRY_FILE = "captain-sessions.jsonl";

/** Append one session record. Creates the spoke vault dir if needed. Never overwrites — the registry is a log, not a snapshot. */
export function appendCaptainSession(spokeVault: string, record: CaptainSessionRecord): void {
  fs.mkdirSync(spokeVault, { recursive: true });
  const file = path.join(spokeVault, CAPTAIN_SESSION_REGISTRY_FILE);
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
}

/** Read every recorded session. A corrupt line is skipped, not fatal. */
export function readCaptainSessionRegistry(spokeVault: string): CaptainSessionRecord[] {
  const file = path.join(spokeVault, CAPTAIN_SESSION_REGISTRY_FILE);
  if (!fs.existsSync(file)) return [];

  const records: CaptainSessionRecord[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as CaptainSessionRecord);
    } catch {
      // skip corrupt line
    }
  }
  return records;
}

export interface GapSessionSelection {
  /** Sessions not covered by the checkpoint (or, with no checkpoint, within the fallback window), newest first. */
  gapSessions: CaptainSessionRecord[];
  /** True when there was no checkpoint at all and selection fell back to a bounded recency window. */
  usedFallbackWindow: boolean;
}

/**
 * The gap: prior captain sessions not yet covered by any archived handoff.
 * Excludes the running session by id (ground truth, not "newest file").
 *
 * With a checkpoint (the newest archived handoff — see handoff-archive.ts),
 * a session is in the gap iff it started strictly after the checkpoint's
 * timestamp — the checkpoint already covers everything before it, so
 * there's no reason to re-read those sessions' transcripts. No window bound
 * applies here: an old checkpoint still fully anchors the boundary.
 *
 * With NO checkpoint at all (nothing has ever been archived), there's no
 * boundary to anchor on, so this falls back to a bounded recency window —
 * otherwise a cold-start project would try to read its entire history.
 */
export function selectGapSessions(
  records: CaptainSessionRecord[],
  currentSessionId: string,
  checkpoint: { ageMs: number } | null,
  now: number,
  fallbackWindowMs: number = SESSION_WINDOW_MS,
): GapSessionSelection {
  const excludingCurrent = records.filter((r) => r.sessionId !== currentSessionId);

  const filtered = checkpoint
    ? excludingCurrent.filter((r) => Date.parse(r.startedAt) > now - checkpoint.ageMs)
    : excludingCurrent.filter((r) => now - Date.parse(r.startedAt) <= fallbackWindowMs);

  return {
    gapSessions: filtered.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
    usedFallbackWindow: !checkpoint,
  };
}
