// config.ts — #1136: per-repo gate config, <repo>/.squadrant/gate.json
import fs from "node:fs";
import path from "node:path";

export interface GateStep {
  name: string;
  command: string;
  /** db/integration steps get the all-skipped meta-check. */
  kind?: "unit" | "db" | "integration" | string;
  /** Default true. A non-required step failing is recorded but does not fail the gate. */
  required?: boolean;
  /** "json": the command writes a vitest/jest JSON report to $SQUADRANT_GATE_JSON. */
  parse?: "json";
}
export interface GateConfig {
  steps: GateStep[];
  /** Base branch for diff-based meta-checks. Default "develop". */
  base?: string;
}

export function loadGateConfig(repo: string): GateConfig {
  const file = path.join(repo, ".squadrant", "gate.json");
  if (!fs.existsSync(file)) throw new Error(`No gate config at ${file}`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as GateConfig;
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error(`${file}: "steps" must be a non-empty array`);
  for (const s of raw.steps) {
    if (typeof s?.name !== "string" || typeof s?.command !== "string") throw new Error(`${file}: each step needs string "name" and "command"`);
  }
  return raw;
}
