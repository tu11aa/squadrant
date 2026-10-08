import fs from "node:fs";
import path from "node:path";
import type { Rule, RuleAnchors, RuleModality, RuleStatus, RuleTriggers } from "@squadrant/shared";
import { kbDir } from "./paths.js";

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

// index.json is a compiled cache for matching/delivery (#899). `rules search` deliberately reads the
// rule files directly, so a stale or missing index never affects search.
export function writeIndex(hubVault: string, kb: string, index: RuleIndex): string {
  const file = path.join(kbDir(hubVault, kb), "index.json");
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return file;
}

export function readIndex(hubVault: string, kb: string): { index: RuleIndex | null; problem?: string } {
  const file = path.join(kbDir(hubVault, kb), "index.json");
  if (!fs.existsSync(file)) return { index: null, problem: `index.json missing for kb '${kb}'` };
  try {
    const index = JSON.parse(fs.readFileSync(file, "utf8")) as RuleIndex;
    if (!Array.isArray(index.rules)) return { index: null, problem: `index.json corrupt for kb '${kb}' (no rules array)` };
    return { index };
  } catch {
    return { index: null, problem: `index.json corrupt for kb '${kb}' (invalid JSON)` };
  }
}
