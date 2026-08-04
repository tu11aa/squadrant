// handoff-archive.ts — #650/#651: the newest archived handoff is the
// CHECKPOINT for reconstruction — it already covers history up to the
// moment it was written, so it's read in full (no recency bound; an old
// checkpoint is still a valid baseline, it just means the gap of sessions
// since it will be correspondingly larger). Read-only; never merged into
// other tiers — emitted raw, the captain interprets.
import fs from "node:fs";
import path from "node:path";
import type { ArchivedHandoff } from "./handoff-facts.js";

/** The newest `<spokeVault>/handoffs/*.json` by mtime, skipping a corrupt file in favor of the next-newest valid one. Null if none exist / all are corrupt. */
export function readNewestArchivedHandoff(spokeVault: string, now: number): ArchivedHandoff | null {
  const dir = path.join(spokeVault, "handoffs");
  if (!fs.existsSync(dir)) return null;

  const candidates = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => {
      const full = path.join(dir, e.name);
      return { name: e.name, full, mtime: fs.statSync(full).mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  for (const candidate of candidates) {
    let content: unknown;
    try {
      content = JSON.parse(fs.readFileSync(candidate.full, "utf-8"));
    } catch {
      continue; // corrupt — try the next-newest
    }
    return { filename: candidate.name, path: candidate.full, ageMs: now - candidate.mtime.getTime(), content };
  }
  return null;
}
