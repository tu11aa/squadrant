import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Rule, RuleAnchors, RuleModality, RuleStatus, RuleTriggers } from "@squadrant/shared";

export interface RuleIndexEntry {
  id: string; domain: string; modality: RuleModality; status: RuleStatus;
  statement: string; triggers?: RuleTriggers; anchors?: RuleAnchors; file: string;
}
export interface RuleIndex { kb: string; compiledAt: string; rules: RuleIndexEntry[] }

export function compileIndex(kb: string, rules: Rule[], now: Date = new Date()): RuleIndex {
  return {
    kb,
    compiledAt: now.toISOString(),
    rules: rules.map(({ id, domain, modality, status, statement, triggers, anchors, file }) =>
      ({ id, domain, modality, status, statement, triggers, anchors, file })),
  };
}

/** K8: the index is a per-machine cache, never part of the KB repo. `SQUADRANT_INDEX_CACHE_DIR` overrides it (tests). */
export const indexCacheDir = () => process.env.SQUADRANT_INDEX_CACHE_DIR || path.join(os.homedir(), ".cache", "squadrant", "index");
export const indexCacheFile = (kb: string) => path.join(indexCacheDir(), `${kb}.json`);

// The index is a compiled cache for matching/delivery (#899), rebuilt by `knowledge reindex` and `doctor`.
// `rules search` deliberately reads the rule files directly, so a stale or missing index never affects search.
// `kbRoot` is unused since K8; it stays so the write call sites keep their shape.
export function writeIndex(_kbRoot: string, index: RuleIndex): string {
  const file = indexCacheFile(index.kb);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return file;
}

export function readIndex(kb: string): { index: RuleIndex | null; problem?: string } {
  const file = indexCacheFile(kb);
  if (!fs.existsSync(file)) return { index: null, problem: `index cache missing for kb '${kb}'` };
  try {
    const index = JSON.parse(fs.readFileSync(file, "utf8")) as RuleIndex;
    if (!Array.isArray(index.rules)) return { index: null, problem: `index cache corrupt for kb '${kb}' (no rules array)` };
    return { index };
  } catch {
    return { index: null, problem: `index cache corrupt for kb '${kb}' (invalid JSON)` };
  }
}

/** The command that retires a pre-K8 `<kb>/index.json` still tracked or on disk. A hint only: never run here (2b-1 automates it). */
export function legacyIndexHint(kbRoot: string): string | undefined {
  let tracked = false;
  try {
    tracked = execFileSync("git", ["-C", kbRoot, "ls-files", "--", "index.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() !== "";
  } catch { /* not a git repo */ }
  if (tracked) return `git -C ${kbRoot} rm --cached index.json`;
  return fs.existsSync(path.join(kbRoot, "index.json")) ? `rm ${path.join(kbRoot, "index.json")}` : undefined;
}
