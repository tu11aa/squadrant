import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import {
  loadConfig, saveConfig, kbConfigs, KB_NAME_RE, DEFAULT_CONFIG_PATH,
  type KnowledgeSourceEntry,
} from "@squadrant/shared";
import {
  kbDir, kbRulesDir, PROPOSED_DIR, SOURCES_TEMPLATE, loadSources, loadKbRules, compileIndex, writeIndex, validateKb,
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
  const { rules: all, errors } = loadKbRules(cfg, kb, { includeProposed: true });
  const proposedRoot = path.join(kbRulesDir(cfg, kb), PROPOSED_DIR) + path.sep;
  const live = all.filter((r) => !r.file.startsWith(proposedRoot));
  const file = writeIndex(kbDir(cfg, kb), compileIndex(kb, live));
  return { file, count: live.length, proposed: all.length - live.length, errors: errors.length, invalid: errors };
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
