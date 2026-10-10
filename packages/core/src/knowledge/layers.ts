import fs from "node:fs";
import { projectRulesHome, subscribedKbs, type Rule, type SquadrantConfig } from "@squadrant/shared";
import { kbDir, kbRulesDir } from "./paths.js";
import { loadRulesDir, type RuleLoadError, type RuleLoadResult } from "./store.js";

export interface ResolvedRules { rules: Rule[]; errors: RuleLoadError[]; warnings: string[] }

export function loadKbRules(cfg: SquadrantConfig, kb: string, opts: { includeProposed?: boolean } = {}): RuleLoadResult {
  return loadRulesDir(kbRulesDir(cfg, kb), `kb:${kb}`, opts);
}

export function resolveProjectRules(
  cfg: SquadrantConfig,
  project: string,
  opts: { includeProposed?: boolean } = {},
): ResolvedRules {
  const pc = cfg.projects[project];
  if (!pc) throw new Error(`Unknown project '${project}'`);
  const byId = new Map<string, Rule>();
  const errors: RuleLoadError[] = [];
  const warnings: string[] = [];

  for (const kb of subscribedKbs(cfg, project)) {
    if (!fs.existsSync(kbDir(cfg, kb))) {
      warnings.push(`knowledge base '${kb}' not found (run: squadrant knowledge init ${kb})`);
      continue;
    }
    const res = loadKbRules(cfg, kb, opts);
    errors.push(...res.errors);
    for (const r of res.rules) {
      const prior = byId.get(r.id);
      if (prior) { warnings.push(`rule '${r.id}' in kb:${kb} shadowed by ${prior.layer}`); continue; }
      byId.set(r.id, r);
    }
  }

  const projDir = projectRulesHome(cfg, project);
  if (projDir) {
    const proj = loadRulesDir(projDir, `project:${project}`, opts);
    errors.push(...proj.errors);
    for (const r of proj.rules) byId.set(r.id, r);
  }

  for (const id of pc.rulesDisabled ?? []) {
    if (!byId.delete(id)) warnings.push(`rulesDisabled: unknown rule id '${id}'`);
  }

  const rules = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { rules, errors, warnings };
}
