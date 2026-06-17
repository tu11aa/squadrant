// src/control/daemon/snapshot-gather.ts
// Snapshot I/O edge: pure helpers that gather raw inputs for the snapshot verb.
// Each tolerates missing files and never throws.
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  statSync, openSync, readSync, closeSync, readdirSync, readFileSync,
} from "node:fs";
import type { DaemonSnapshotInputs, ResultArtifacts } from "../snapshot.js";
import type { TaskRecord } from "@cockpit/shared";

// The compiled snapshot-gather.js shares the dist/ build time with cockpitd.js
// (tsup compiles all entries in the same pass), so its mtime == dist build-time.
const SELF_PATH = fileURLToPath(import.meta.url);

/** mtime (epoch ms) of the running daemon's compiled code, for build-freshness. */
export function distBuiltAt(): number {
  try { return statSync(SELF_PATH).mtimeMs; } catch { return 0; }
}

/** Daemon-log error count (last window) + total size. Reads only the tail so a
 *  large log never makes the snapshot tick expensive. */
export function gatherLogStats(path: string, now: number, windowMs: number): DaemonSnapshotInputs["log"] {
  let sizeBytes = 0;
  try { sizeBytes = statSync(path).size; }
  catch { return { errorCount: 0, sizeBytes: 0, windowMs }; }
  if (sizeBytes === 0) return { errorCount: 0, sizeBytes, windowMs };
  const CAP = 256 * 1024;
  const start = Math.max(0, sizeBytes - CAP);
  const len = sizeBytes - start;
  let text = "";
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      text = buf.toString("utf-8");
    } finally { closeSync(fd); }
  } catch { return { errorCount: 0, sizeBytes, windowMs }; }
  const cutoff = now - windowMs;
  let errorCount = 0;
  for (const line of text.split("\n")) {
    if (!/error|failed/i.test(line)) continue;
    // Lines carry an ISO timestamp ("[cockpitd] 2026-... msg"); skip ones older
    // than the window. Lines without a parseable timestamp are counted (conservative).
    const m = line.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
    if (m) { const ts = Date.parse(m[0]); if (!Number.isNaN(ts) && ts < cutoff) continue; }
    errorCount++;
  }
  return { errorCount, sizeBytes, windowMs };
}

/** Per-project store state counts + corrupt/quarantined file count. */
export function gatherStoreStats(
  store: { list: (p: string) => TaskRecord[] },
  stateRoot: string,
  project: string,
): { byState: Record<string, number>; corruptCount: number } {
  const byState: Record<string, number> = {};
  for (const r of store.list(project)) byState[r.state] = (byState[r.state] ?? 0) + 1;
  let corruptCount = 0;
  const dir = join(stateRoot, project);
  try {
    for (const n of readdirSync(dir)) {
      if (n.includes(".corrupt.")) { corruptCount++; continue; }
      if (!n.endsWith(".json")) continue;
      try { JSON.parse(readFileSync(join(dir, n), "utf-8")); }
      catch { corruptCount++; }
    }
  } catch { /* no project dir yet */ }
  return { byState, corruptCount };
}

/** Global _results/ artifact count + total bytes (unbounded-growth watch). */
export function gatherResults(resultsDir: string): ResultArtifacts {
  let fileCount = 0;
  let totalBytes = 0;
  try {
    for (const n of readdirSync(resultsDir)) {
      try {
        const s = statSync(join(resultsDir, n));
        if (s.isFile()) { fileCount++; totalBytes += s.size; }
      } catch { /* vanished mid-scan */ }
    }
  } catch { /* no results dir */ }
  return { fileCount, totalBytes };
}
