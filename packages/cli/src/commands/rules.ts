import { Command } from "commander";
import chalk from "chalk";
import {
  loadConfig, DEFAULT_CONFIG_PATH, RULE_STATUSES, type Rule, type RuleStatus, type SquadrantConfig,
} from "@squadrant/shared";
import { resolveProjectRules, searchRules, DEFAULT_SEARCH_STATUSES, type SearchHit } from "@squadrant/core";
import { detectCurrentProject } from "./work.js";

interface RulesOpts { project?: string; all?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }

export function resolveRulesProject(cfg: SquadrantConfig, opts: RulesOpts): string {
  const env = opts.env ?? process.env;
  const name = opts.project ?? env.SQUADRANT_CREW_PROJECT ?? detectCurrentProject(cfg, opts.cwd ?? process.cwd());
  if (!name) throw new Error("Not inside a registered project. Pass --project <name>.");
  if (!cfg.projects[name]) throw new Error(`Unknown project '${name}'`);
  return name;
}

export function formatRule(rule: Rule): string {
  const src = rule.sources.map((s) => `${s.ref}${s.loc ? ` ${s.loc}` : ""}`).join("; ");
  return [
    `${rule.modality.toUpperCase()} ${rule.statement}`,
    `  ${rule.id} · ${rule.domain} · ${rule.status} · ${rule.layer}`,
    `  source: ${src}`,
  ].join("\n");
}

function loadFor(opts: RulesOpts, configPath: string): { rules: Rule[]; warnings: string[] } {
  const cfg = loadConfig(configPath);
  const project = resolveRulesProject(cfg, opts);
  const res = resolveProjectRules(cfg, project, { includeProposed: opts.all });
  return { rules: res.rules, warnings: [...res.warnings, ...res.errors.map((e) => `${e.file}: ${e.problems.join("; ")}`)] };
}

export function runRulesSearch(query: string, opts: RulesOpts, configPath = DEFAULT_CONFIG_PATH): SearchHit[] {
  const { rules } = loadFor(opts, configPath);
  return searchRules(rules, query, { statuses: opts.all ? [...RULE_STATUSES] : DEFAULT_SEARCH_STATUSES });
}

export function runRulesShow(id: string, opts: RulesOpts, configPath = DEFAULT_CONFIG_PATH): Rule {
  const { rules } = loadFor(opts, configPath);
  const statuses: readonly RuleStatus[] = opts.all ? RULE_STATUSES : DEFAULT_SEARCH_STATUSES;
  const rule = rules.find((r) => r.id === id && statuses.includes(r.status));
  if (!rule) throw new Error(`No rule '${id}' for this project`);
  return rule;
}

export const rulesCommand = new Command("rules").description("Look up rules from subscribed knowledge bases (#893)");

rulesCommand
  .command("search <query...>")
  .description("Search rules by keyword")
  .option("--project <name>", "project (default: from cwd or SQUADRANT_CREW_PROJECT)")
  .option("--all", "include proposed and retired rules")
  .action((query: string[], opts: RulesOpts) => {
    const hits = runRulesSearch(query.join(" "), opts);
    if (!hits.length) { console.log("(no matching rules)"); return; }
    for (const h of hits) console.log(formatRule(h.rule) + "\n");
  });

rulesCommand
  .command("show <ids...>")
  .description("Show one or more rules in full")
  .option("--project <name>", "project (default: from cwd or SQUADRANT_CREW_PROJECT)")
  .option("--all", "include proposed and retired rules")
  .action((ids: string[], opts: RulesOpts) => {
    for (const id of ids) {
      const r = runRulesShow(id, opts);
      console.log(formatRule(r));
      console.log(chalk.dim(r.body) + "\n");
    }
  });
