// risk-map.ts — #1136: per-repo map of path globs → tier. Reader + pure helpers.
// File: <repo>/.squadrant/risk-map.json
import fs from "node:fs";
import path from "node:path";

export type Tier = "high" | "med" | "low";
export interface RiskEntry {
  glob: string;
  tier: Tier;
  invariants?: string[];
  requiredSteps?: string[];
}
export interface RiskMap {
  entries: RiskEntry[];
}

const TIERS: Tier[] = ["high", "med", "low"];

export function loadRiskMap(repo: string): RiskMap | null {
  const file = path.join(repo, ".squadrant", "risk-map.json");
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { entries?: unknown };
  if (!Array.isArray(raw.entries)) throw new Error(`${file}: "entries" must be an array`);
  for (const e of raw.entries as RiskEntry[]) {
    if (typeof e?.glob !== "string" || !TIERS.includes(e.tier)) {
      throw new Error(`${file}: each entry needs a string "glob" and tier high|med|low`);
    }
  }
  return { entries: raw.entries as RiskEntry[] };
}

/** `**` any depth, `*` within a segment, `?` one char. No other syntax. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchEntries(map: RiskMap, file: string): RiskEntry[] {
  return map.entries.filter((e) => globToRegExp(e.glob).test(file));
}

export function isHighTier(map: RiskMap | null, file: string): boolean {
  return !!map && matchEntries(map, file).some((e) => e.tier === "high");
}

export interface HighTouch {
  file: string;
  invariants: string[];
}

/** High-tier files touched, each with the invariants of every high entry that matches it. */
export function touchedHigh(map: RiskMap | null, files: string[]): HighTouch[] {
  if (!map) return [];
  const out: HighTouch[] = [];
  for (const file of files) {
    const hits = matchEntries(map, file).filter((e) => e.tier === "high");
    if (hits.length) out.push({ file, invariants: [...new Set(hits.flatMap((e) => e.invariants ?? []))] });
  }
  return out;
}

export interface RiskAssessment {
  label: Tier;
  touchedHigh: HighTouch[];
  requiredSteps: string[];
}

/** Label = highest tier among matched files (no match, or no files → low). */
export function assessRisk(map: RiskMap | null, files: string[]): RiskAssessment {
  const high = touchedHigh(map, files);
  const matched = map ? files.flatMap((f) => matchEntries(map, f)) : [];
  const label: Tier = high.length ? "high" : matched.some((e) => e.tier === "med") ? "med" : "low";
  const requiredSteps = [...new Set(matched.filter((e) => e.tier === "high").flatMap((e) => e.requiredSteps ?? []))];
  return { label, touchedHigh: high, requiredSteps };
}
