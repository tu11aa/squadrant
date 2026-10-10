import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import {
  loadConfig, saveConfig, kbConfigs, subscribedKbs, resolveHome, KB_NAME_RE, DEFAULT_CONFIG_PATH,
  type KnowledgeSourceEntry,
} from "@squadrant/shared";
import {
  kbDir, kbRulesDir, PROPOSED_DIR, SOURCES_TEMPLATE, loadSources, loadKbRules, compileIndex, writeIndex, validateKb, isPendingProposalDup,
  planIngest, applyCandidates, DEFAULT_MAX_SECTIONS_PER_PASS, type IngestPlan, type CandidateFile, type ApplyResult,
  ensureGitRepo, moveLegacyKbs, moveLegacyOverlays, type KbMoveEntry,
} from "@squadrant/core";

export const KNOWLEDGE_PRIVACY_NOTICE =
  "Sources are sent to the extraction crew's model; mark `sensitivity: local-only` to keep a source on local models only.";

function assertKbName(kb: string): void {
  if (!KB_NAME_RE.test(kb)) throw new Error(`Invalid knowledge base name '${kb}' (use lowercase letters, digits, '-')`);
}

export function runKnowledgeInit(kb: string, configPath = DEFAULT_CONFIG_PATH): { dir: string; created: string[] } {
  assertKbName(kb);
  const cfg = loadConfig(configPath);
  const dir = kbDir(cfg, kb);
  const created: string[] = [];
  for (const d of [path.join(dir, "raw"), kbRulesDir(cfg, kb), path.join(kbRulesDir(cfg, kb), PROPOSED_DIR)]) {
    if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); created.push(path.relative(dir, d)); }
  }
  const sourcesFile = path.join(dir, "sources.yaml");
  if (!fs.existsSync(sourcesFile)) { fs.writeFileSync(sourcesFile, SOURCES_TEMPLATE); created.push("sources.yaml"); }
  if (!fs.existsSync(path.join(dir, "index.json"))) { writeIndex(dir, compileIndex(kb, [])); created.push("index.json"); }
  if (ensureGitRepo(dir)) created.push(".git");
  if (!kbConfigs(cfg)[kb]) {
    cfg.knowledgeBases = { ...(cfg.knowledgeBases ?? {}), [kb]: {} };
    saveConfig(cfg, configPath);
  }
  return { dir, created };
}

export function runKnowledgeSubscribe(kb: string, project: string, configPath = DEFAULT_CONFIG_PATH): string[] {
  assertKbName(kb);
  const cfg = loadConfig(configPath);
  const pc = cfg.projects[project];
  if (!pc) throw new Error(`Unknown project '${project}'`);
  if (!fs.existsSync(kbDir(cfg, kb))) {
    throw new Error(`Knowledge base '${kb}' does not exist. Run: squadrant knowledge init ${kb}`);
  }
  const list = pc.knowledge ?? [];
  if (!list.includes(kb)) {
    pc.knowledge = [...list, kb];
    saveConfig(cfg, configPath);
  }
  return pc.knowledge ?? list;
}

export function runKnowledgeSources(kb: string, configPath = DEFAULT_CONFIG_PATH): { sources: KnowledgeSourceEntry[]; errors: string[] } {
  assertKbName(kb);
  const cfg = loadConfig(configPath);
  return loadSources(kbDir(cfg, kb));
}

export const knowledgeCommand = new Command("knowledge").description("Manage rules knowledge bases (#893)");

knowledgeCommand
  .command("init <kb>")
  .description("Create a knowledge base (its own git repo) under ~/squadrant/kb/<kb>/")
  .action((kb: string) => {
    const { dir, created } = runKnowledgeInit(kb);
    console.log(created.length ? chalk.green(`Initialised ${dir} (${created.join(", ")})`) : `Already initialised: ${dir}`);
    console.log(chalk.dim(KNOWLEDGE_PRIVACY_NOTICE));
  });

knowledgeCommand
  .command("subscribe <kb>")
  .description("Subscribe a project to a knowledge base")
  .requiredOption("--project <name>", "project to subscribe")
  .action((kb: string, opts: { project: string }) => {
    const list = runKnowledgeSubscribe(kb, opts.project);
    console.log(`${opts.project} knowledge: ${list.join(", ")}`);
  });

knowledgeCommand
  .command("sources <kb>")
  .description("List the trusted sources of a knowledge base")
  .action((kb: string) => {
    const { sources, errors } = runKnowledgeSources(kb);
    if (!sources.length && !errors.length) console.log("(no sources — edit sources.yaml)");
    for (const s of sources) {
      console.log(`  ${s.priority.padEnd(8)} ${s.path}${s.domain ? `  [${s.domain}]` : ""}${s.sensitivity ? chalk.yellow("  local-only") : ""}`);
    }
    for (const e of errors) console.log(chalk.red(`  ✘ ${e}`));
    if (errors.length) process.exitCode = 1;
  });

export function runKnowledgeReindex(kb: string, configPath = DEFAULT_CONFIG_PATH): {
  file: string; count: number; proposed: number; errors: number; invalid: { file: string; problems: string[] }[];
} {
  assertKbName(kb);
  const cfg = loadConfig(configPath);
  if (!fs.existsSync(kbDir(cfg, kb))) throw new Error(`Knowledge base '${kb}' does not exist. Run: squadrant knowledge init ${kb}`);
  const { rules: all, errors: allErrors } = loadKbRules(cfg, kb, { includeProposed: true });
  const proposedRoot = path.join(kbRulesDir(cfg, kb), PROPOSED_DIR) + path.sep;
  const live = all.filter((r) => !r.file.startsWith(proposedRoot));
  const pendingDups = allErrors.filter((e) => isPendingProposalDup(e, kbRulesDir(cfg, kb)));
  const errors = allErrors.filter((e) => !pendingDups.includes(e));
  const file = writeIndex(kbDir(cfg, kb), compileIndex(kb, live));
  return { file, count: live.length, proposed: all.length - live.length + pendingDups.length, errors: errors.length, invalid: errors };
}

export function runKnowledgeValidate(kb: string, configPath = DEFAULT_CONFIG_PATH): ReturnType<typeof validateKb> {
  assertKbName(kb);
  const cfg = loadConfig(configPath);
  if (!fs.existsSync(kbDir(cfg, kb))) throw new Error(`Knowledge base '${kb}' does not exist. Run: squadrant knowledge init ${kb}`);
  const { sources, errors } = loadSources(kbDir(cfg, kb));
  const res = validateKb({ rulesDir: kbRulesDir(cfg, kb), kbRoot: kbDir(cfg, kb), sources, domains: kbConfigs(cfg)[kb]?.domains });
  const srcChecks = errors.map((e) => ({ level: "fail" as const, message: `sources.yaml: ${e}` }));
  return { checks: [...srcChecks, ...res.checks], ok: res.ok && !errors.length };
}

knowledgeCommand
  .command("reindex <kb>")
  .description("Recompile index.json from the KB's rule files")
  .action((kb: string) => {
    const r = runKnowledgeReindex(kb);
    console.log(`${r.file}: ${r.count} active${r.proposed ? ` (+${r.proposed} proposed)` : ""}${r.errors ? chalk.red(`, ${r.errors} invalid files skipped`) : ""}`);
    for (const e of r.invalid) console.log(chalk.red(`  ✘ ${e.file}: ${e.problems.join("; ")}`));
  });

knowledgeCommand
  .command("validate <kb>")
  .description("CI-style check: invalid files, duplicate ids, quotes present in sources; exits non-zero on failure")
  .action((kb: string) => {
    const { checks, ok } = runKnowledgeValidate(kb);
    const mark = { ok: chalk.green("✔"), fail: chalk.red("✘"), warn: chalk.yellow("!"), skip: chalk.dim("-") };
    for (const c of checks) console.log(`${mark[c.level]} ${c.message}`);
    console.log(ok ? chalk.green("valid") : chalk.red("invalid"));
    if (!ok) process.exitCode = 1;
  });

export function runKnowledgeMigrate(opts: { dryRun?: boolean } = {}, configPath = DEFAULT_CONFIG_PATH): KbMoveEntry[] {
  const cfg = loadConfig(configPath);
  // KBs first: an overlay target may live inside a KB that was just moved.
  return [...moveLegacyKbs(cfg, opts), ...moveLegacyOverlays(cfg, opts)];
}

knowledgeCommand
  .command("migrate")
  .description("Move <hubVault>/knowledge/<kb>/ to ~/squadrant/kb/<kb>/ and <spokeVault>/knowledge/rules/ to each project's overlay home (never deletes; prints a report)")
  .option("--dry-run", "show what would move")
  .action((opts: { dryRun?: boolean }) => {
    const report = runKnowledgeMigrate(opts);
    if (!report.length) console.log("Nothing to migrate: no knowledge bases under <hubVault>/knowledge/ and no spoke overlays.");
    for (const e of report) console.log(`${e.action.padEnd(10)} ${e.kb}: ${e.from} -> ${e.to}${e.note ? chalk.dim(` (${e.note})`) : ""}`);
  });

function requireKb(kb: string, configPath: string) {
  assertKbName(kb);
  const cfg = loadConfig(configPath);
  if (!fs.existsSync(kbDir(cfg, kb))) throw new Error(`Knowledge base '${kb}' does not exist. Run: squadrant knowledge init ${kb}`);
  return cfg;
}

export async function runKnowledgeIngest(
  kb: string,
  opts: { dryRun?: boolean; localModel?: boolean; maxSections?: number } = {},
  configPath = DEFAULT_CONFIG_PATH,
): Promise<IngestPlan> {
  const cfg = requireKb(kb, configPath);
  const root = kbDir(cfg, kb);
  const { sources, errors } = loadSources(root);
  if (errors.length) throw new Error(`sources.yaml: ${errors.join("; ")}`);
  const existing = loadKbRules(cfg, kb).rules.map((r) => ({ id: r.id, domain: r.domain, statement: r.statement }));
  return planIngest(root, {
    sources, existing, dryRun: opts.dryRun, localModel: opts.localModel,
    maxSectionsPerPass: opts.maxSections ?? kbConfigs(cfg)[kb]?.maxSectionsPerPass ?? DEFAULT_MAX_SECTIONS_PER_PASS,
  });
}

export function runKnowledgeApply(kb: string, candidatesFile: string, configPath = DEFAULT_CONFIG_PATH): ApplyResult {
  const cfg = requireKb(kb, configPath);
  const input = JSON.parse(fs.readFileSync(candidatesFile, "utf8")) as CandidateFile;
  if (!input || !Array.isArray(input.candidates)) throw new Error("candidates file must be { complete?: string[], candidates: [...] }");
  const projects = Object.entries(cfg.projects)
    .filter(([name, pc]) => pc.path && subscribedKbs(cfg, name).includes(kb))
    .map(([name, pc]) => ({ name, root: resolveHome(pc.path) }));
  return applyCandidates(input, { kb, kbRoot: kbDir(cfg, kb), rulesDir: kbRulesDir(cfg, kb), projects });
}

knowledgeCommand
  .command("ingest <kb>")
  .description("Detect changed sources, convert them (markitdown) into .converted/, and print the section plan for the knowledge-extract skill")
  .option("--dry-run", "estimate tokens only; write nothing")
  .option("--json", "print the full plan as JSON")
  .option("--local-model", "a local model is available, so sensitivity: local-only sources are planned instead of skipped")
  .option("--max-sections <n>", "override maxSectionsPerPass", (v) => parseInt(v, 10))
  .action(async (kb: string, opts: { dryRun?: boolean; json?: boolean; localModel?: boolean; maxSections?: number }) => {
    const plan = await runKnowledgeIngest(kb, opts);
    if (opts.json) { console.log(JSON.stringify(plan, null, 2)); return; }
    for (const s of plan.sources) console.log(`  ${s.ref}  ${s.sections.length}/${s.totalSections} sections${s.sensitivity ? chalk.yellow("  local-only") : ""}`);
    for (const s of plan.skipped) console.log(chalk.yellow(`  skipped ${s.ref}: ${s.reason}`));
    for (const f of plan.failed) console.log(chalk.red(`  ✘ ${f.ref}: conversion failed: ${f.error}`));
    console.log(`${plan.sectionCount} sections, ~${plan.estimatedTokens} input tokens${plan.carriedSections ? `, ${plan.carriedSections} carried to the next pass` : ""}${opts.dryRun ? " (dry run)" : ""}`);
    if (plan.failed.length) process.exitCode = 1;
  });

knowledgeCommand
  .command("apply <kb> <candidates>")
  .description("Verify extracted candidates (quote grounding, offset id-matching), classify changes, write rules/_proposed, anchor, reindex")
  .action((kb: string, file: string) => {
    const r = runKnowledgeApply(kb, file);
    console.log(`created ${r.created.length}, merged ${r.merged.length}, proposed ${r.proposed.length}, superseded ${r.superseded.length}, stale ${r.stale.length}, rejected ${r.rejected.length}`);
    for (const x of r.rejected) console.log(chalk.red(`  ✘ ${x.id} (${x.source}): ${x.reason}`));
    for (const x of r.idOverrides) console.log(chalk.dim(`  id ${x.from} → ${x.to} (matched by quote offset)`));
    for (const d of r.doclingFlags) console.log(chalk.yellow(`  ${d.ref}: ${d.dropped}/${d.total} candidates dropped; conversion likely poor, try docling`));
  });
