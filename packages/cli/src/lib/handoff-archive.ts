// handoff-archive.ts — #650/#651: the newest archived handoff is the
// CHECKPOINT for reconstruction — it already covers history up to the
// moment it was written, so it's read in full (no recency bound; an old
// checkpoint is still a valid baseline, it just means the gap of sessions
// since it will be correspondingly larger). Read-only; never merged into
// other tiers — emitted raw, the captain interprets.
import fs from "node:fs";
import path from "node:path";
import type { ArchivedHandoff } from "./handoff-facts.js";

/** The newest of `<spokeVault>/handoffs/*.json` and the not-yet-archived `<spokeVault>/handoff.json`, by mtime, skipping a corrupt file in favor of the next-newest valid one. Null if none exist / all are corrupt.
 *
 *  The live `handoff.json` counts because `handoff facts` runs BEFORE `read-handoff.sh` archives it:
 *  looking only in handoffs/ made facts bound the gap by an older archive and print a stale copy,
 *  while the captain read the real one separately. When the live file wins, its content is not
 *  repeated (`live: true`, `content: null`) — the captain reads it via read-handoff.sh. `includeLive: false` restricts to handoffs/ (callers that sweep the live file separately). */
export function readNewestArchivedHandoff(spokeVault: string, now: number, includeLive = true): ArchivedHandoff | null {
  const dir = path.join(spokeVault, "handoffs");
  const archived = fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => {
          const full = path.join(dir, e.name);
          return { name: e.name, full, mtime: fs.statSync(full).mtime, live: false };
        })
    : [];
  const liveFile = path.join(spokeVault, "handoff.json");
  const live = includeLive && fs.existsSync(liveFile) ? [{ name: "handoff.json", full: liveFile, mtime: fs.statSync(liveFile).mtime, live: true }] : [];

  const candidates = [...archived, ...live].sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  for (const candidate of candidates) {
    let content: unknown;
    try {
      content = JSON.parse(fs.readFileSync(candidate.full, "utf-8"));
    } catch {
      continue; // corrupt — try the next-newest
    }
    return { filename: candidate.name, path: candidate.full, ageMs: now - candidate.mtime.getTime(), content: candidate.live ? null : content, ...(candidate.live ? { live: true } : {}) };
  }
  return null;
}
