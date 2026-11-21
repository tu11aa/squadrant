// config.ts — #1136: per-repo verify config, <repo>/.squadrant/verify.json
import fs from "node:fs";
import path from "node:path";

export interface VerifyStep {
  name: string;
  command: string;
  /** db/integration steps get the all-skipped meta-check. */
  kind?: "unit" | "db" | "integration" | string;
  /** Default true. A non-required step failing is recorded but does not fail verification. */
  required?: boolean;
  /** "json": the command writes a vitest/jest JSON report to $SQUADRANT_VERIFY_JSON. */
  parse?: "json";
}
export interface VerifyConfig {
  steps: VerifyStep[];
  /** Base branch for diff-based meta-checks. Default "develop". */
  base?: string;
}

export function loadVerifyConfig(repo: string): VerifyConfig {
  const file = path.join(repo, ".squadrant", "verify.json");
  if (!fs.existsSync(file)) throw new Error(`No verify config at ${file}`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as VerifyConfig;
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error(`${file}: "steps" must be a non-empty array`);
  for (const s of raw.steps) {
    if (typeof s?.name !== "string" || typeof s?.command !== "string") throw new Error(`${file}: each step needs string "name" and "command"`);
  }
  return raw;
}
