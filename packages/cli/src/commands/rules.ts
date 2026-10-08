import { Command } from "commander";
import chalk from "chalk";
import {
  loadConfig, DEFAULT_CONFIG_PATH, RULE_STATUSES, type Rule, type RuleStatus, type SquadrantConfig,
} from "@squadrant/shared";
import { resolveProjectRules, searchRules, DEFAULT_SEARCH_STATUSES, type SearchHit } from "@squadrant/core";
import { detectCurrentProject } from "./work.js";

interface RulesOpts {
  project?: string; all?: boolean; cwd?: string; env?: NodeJS.ProcessEnv;
  limit?: string | number; brief?: boolean; idsOnly?: boolean;
}

export const DEFAULT_SEARCH_LIMIT = 5;

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

export function formatBrief(rule: Rule): string {
  return `${rule.modality.toUpperCase()} ${rule.id}: ${rule.statement}`;
}

export function parseLimit(raw: string | number | undefined): number {
  if (raw === undefined) return DEFAULT_SEARCH_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--limit must be a positive integer, got '${raw}'`);
  return n;
}

/** Lines to print for a search; always non-empty (no-match and truncation are explicit). */
export function renderSearch(hits: SearchHit[], opts: RulesOpts): string[] {
  if (!hits.length) return ["(no matching rules)"];
  const limit = parseLimit(opts.limit);
  const shown = hits.slice(0, limit);
  const lines = shown.map((h) =>
    opts.idsOnly ? h.rule.id
      : opts.brief ? `[${h.score}] ${formatBrief(h.rule)}`
      : `${formatRule(h.rule)}\n  score: ${h.score}\n`);
  const more = hits.length - shown.length;
  if (more > 0) lines.push(`(+${more} more; use --limit)`);
  return lines;
}

export function renderList(rules: Rule[], opts: RulesOpts): string[] {
  if (!rules.length) return ["(no rules)"];
  const sorted = [...rules].sort((a, b) => a.id.localeCompare(b.id));
  return sorted.map((r) => opts.brief ? formatBrief(r) : `${formatBrief(r)}\n  ${r.status} · ${r.layer}`);
}

function loadFor(opts: RulesOpts, configPath: string): Rule[] {
  const cfg = loadConfig(configPath);
  const project = resolveRulesProject(cfg, opts);
  const res = resolveProjectRules(cfg, project, { includeProposed: opts.all });
  for (const w of res.warnings) console.error(chalk.yellow(`warning: ${w}`));
  for (const e of res.errors) console.error(chalk.yellow(`skipped ${e.file}: ${e.problems.join("; ")}`));
  return res.rules;
}

export function runRulesSearch(query: string, opts: RulesOpts, configPath = DEFAULT_CONFIG_PATH): SearchHit[] {
  const rules = loadFor(opts, configPath);
  return searchRules(rules, query, { statuses: opts.all ? [...RULE_STATUSES] : DEFAULT_SEARCH_STATUSES });
}

export function runRulesList(opts: RulesOpts, configPath = DEFAULT_CONFIG_PATH): Rule[] {
  const statuses: readonly RuleStatus[] = opts.all ? RULE_STATUSES : DEFAULT_SEARCH_STATUSES;
  return loadFor(opts, configPath).filter((r) => statuses.includes(r.status));
}

export function runRulesShow(id: string, opts: RulesOpts, configPath = DEFAULT_CONFIG_PATH): Rule {
  const rules = loadFor(opts, configPath);
  const statuses: readonly RuleStatus[] = opts.all ? RULE_STATUSES : DEFAULT_SEARCH_STATUSES;
  const rule = rules.find((r) => r.id === id && statuses.includes(r.status));
  if (!rule) throw new Error(`No rule '${id}' for this project`);
  return rule;
}

export const rulesCommand = new Command("rules").description("Look up rules from subscribed knowledge bases (#893)");

rulesCommand
  .command("search <query...>")
  .description("Search rules by keyword (ranked; best match first)")
  .option("--project <name>", "project (default: from cwd or SQUADRANT_CREW_PROJECT)")
  .option("--all", "include proposed and retired rules")
  .option("--limit <n>", `max results (default ${DEFAULT_SEARCH_LIMIT})`)
  .option("--brief", "one line per rule: [score] MODALITY id: statement")
  .option("--ids-only", "print only rule ids")
  .action((query: string[], opts: RulesOpts) => {
    const hits = runRulesSearch(query.join(" "), opts);
    for (const line of renderSearch(hits, opts)) console.log(line);
  });

rulesCommand
  .command("list")
  .description("List every resolved rule for the project")
  .option("--project <name>", "project (default: from cwd or SQUADRANT_CREW_PROJECT)")
  .option("--all", "include proposed and retired rules")
  .option("--brief", "one line per rule: MODALITY id: statement")
  .action((opts: RulesOpts) => {
    for (const line of renderList(runRulesList(opts), opts)) console.log(line);
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
