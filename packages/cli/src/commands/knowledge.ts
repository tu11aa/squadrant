import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import chalk from "chalk";
import {
  loadConfig, saveConfig, kbConfigs, resolveKbConfig, subscribedKbs, resolveHome, KB_NAME_RE, DEFAULT_CONFIG_PATH, stateRoot,
  KB_DOMAINS, isKbDomain, type KbDomain, type KnowledgeSourceEntry,
} from "@squadrant/shared";
import {
  kbDir, kbRulesDir, PROPOSED_DIR, SOURCES_TEMPLATE, loadSources, loadKbRules, compileIndex, writeIndex, validateKb, isPendingProposalDup, loadErrata, removeSource, type RemoveSourceResult,
  planIngest, applyCandidates, DEFAULT_MAX_SECTIONS_PER_PASS, type IngestPlan, type CandidateFile, type ApplyResult,
  ensureGitRepo, ensureKbGitignore, moveLegacyKbs, moveLegacyOverlays, type KbMoveEntry,
  appendCaptainMessage, applyDecisions, buildReviewPacket, finishReconcile, proposeAgentRule, readEscalations, readSchedule, requestPass,
  resolveEscalation, duePass, reconcileConfig, appendAudit, ruleAuditScope, resolveProjectRules, scoreKb, scanAndLogCitations, scanCitations, readGitMessages,
  readAuditRecords, DELIVERY_EVENTS, OUTCOME_SOURCES, type OutcomeSource,
  type Scores, type AuditSink, loadKbRules as loadRules, type DecisionFile, type Resolution, type ReviewContext,
} from "@squadrant/core";
import type { Rule, RuleModality } from "@squadrant/shared";
import { resolveRulesProject } from "./rules.js";

export const KNOWLEDGE_PRIVACY_NOTICE =
  "Sources are sent to the extraction crew's model; mark `sensitivity: local-only` to keep a source on local models only.";

/**
 * D3: `--domain` names a KB domain (rules|decisions|wiki|profile). For one version, any other value is read as a
 * rule category, with a deprecation line on stderr; `--category` is the new flag for that.
 */
export function parseDomainFlag(o: { domain?: string; category?: string }, warn: (m: string) => void = (m) => console.error(chalk.yellow(m))): { kbDomain?: KbDomain; category?: string } {
  if (o.domain === undefined || isKbDomain(o.domain)) return { kbDomain: o.domain as KbDomain | undefined, category: o.category };
  warn(`warning: --domain ${o.domain} is a rule category; use --category ${o.domain} (--domain now means ${KB_DOMAINS.join("|")})`);
  return { kbDomain: "rules", category: o.category ?? o.domain };
}

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
  if (ensureKbGitignore(dir)) created.push(".gitignore");
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

export function runKnowledgeSourcesRemove(kb: string, entryPath: string, opts: { dryRun?: boolean } = {}, configPath = DEFAULT_CONFIG_PATH): RemoveSourceResult {
  assertKbName(kb);
  const cfg = loadConfig(configPath);
  if (!fs.existsSync(kbDir(cfg, kb))) throw new Error(`Knowledge base '${kb}' does not exist. Run: squadrant knowledge init ${kb}`);
  return removeSource(kbDir(cfg, kb), kbRulesDir(cfg, kb), entryPath, { ...opts, kbName: kb });
}

export const knowledgeCommand = new Command("knowledge").description("Manage rules knowledge bases (#893)");

knowledgeCommand
  .command("init <kb>")
  .description("Create a knowledge base (its own git repo) under ~/squadrant/kb/<kb>/")
  .action((kb: string) => {
    const { dir, created } = runKnowledgeInit(kb);
    console.log(created.length ? chalk.green(`Initialised ${dir} (${created.join(", ")})`) : `Already initialised: ${dir}`);
    console.log(chalk.dim("raw/ and .converted/ are git-ignored by default (edit .gitignore to opt in)."));
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
  .description("List the trusted sources of a knowledge base; --remove drops one and strips its refs from rules")
  .option("--remove <path>", "remove the sources.yaml entry with this exact path; rules left with no source become stale")
  .option("--dry-run", "with --remove: print what would change, write nothing")
  .action((kb: string, o: { remove?: string; dryRun?: boolean }) => {
    if (o.dryRun && !o.remove) throw new Error("--dry-run only applies to --remove");
    if (o.remove) {
      const r = runKnowledgeSourcesRemove(kb, o.remove, { dryRun: o.dryRun });
      const stripped = r.stripped.length - r.stale.length;
      console.log(`${r.dryRun ? "would remove" : "removed"} ${o.remove}: ${r.stripped.length} rules lose a ref, ${r.stale.length} left with no source (stale), ${stripped} keep another source`);
      for (const id of r.stale) console.log(chalk.yellow(`  stale: ${id}`));
      if (r.dryRun) console.log(chalk.dim("dry run: nothing written"));
      return;
    }
    const { sources, errors } = runKnowledgeSources(kb);
    if (!sources.length && !errors.length) console.log("(no sources — edit sources.yaml)");
    for (const s of sources) {
      console.log(`  ${s.priority.padEnd(8)} ${s.path}${s.domain ? `  [${s.domain}]` : ""}${s.sensitivity ? chalk.yellow("  local-only") : ""}${s.review ? chalk.cyan("  review: required") : ""}`);
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
  const { errata, errors: errataErrors } = loadErrata(kbDir(cfg, kb));
  const res = validateKb({ rulesDir: kbRulesDir(cfg, kb), kbRoot: kbDir(cfg, kb), sources, errata, domains: kbConfigs(cfg)[kb]?.domains });
  const srcChecks = [
    ...errors.map((e) => ({ level: "fail" as const, message: `sources.yaml: ${e}` })),
    ...errataErrors.map((e) => ({ level: "fail" as const, message: `errata.yaml: ${e}` })),
  ];
  return { checks: [...srcChecks, ...res.checks], ok: res.ok && !srcChecks.length };
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
  .description("Move <hubVault>/knowledge/<kb>/ to ~/squadrant/kb/<kb>/ and <spokeVault>/knowledge/rules/ to each project's overlay home (never deletes; prints a report). Also part of: squadrant migrate kb")
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
  // A broken errata.yaml or sources.yaml must stop apply: ignoring it would let stale passages go live, or drop a review: required gate.
  const { errata, errors } = loadErrata(kbDir(cfg, kb));
  if (errors.length) throw new Error(`errata.yaml: ${errors.join("; ")}`);
  const { sources, errors: sourceErrors } = loadSources(kbDir(cfg, kb));
  if (sourceErrors.length) throw new Error(`sources.yaml: ${sourceErrors.join("; ")}`);
  return applyCandidates(input, { kb, kbRoot: kbDir(cfg, kb), rulesDir: kbRulesDir(cfg, kb), projects, sources, errata });
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
    for (const e of r.orphanedErrata) console.log(chalk.yellow(`  errata ${e.id} (${e.ref}): quote no longer found; the raw file changed, re-check it`));
    for (const d of r.doclingFlags) console.log(chalk.yellow(`  ${d.ref}: ${d.dropped}/${d.total} candidates dropped; conversion likely poor, try docling`));
  });

const defaultStateRoot = () => stateRoot();

function reviewContext(kb: string, configPath: string): ReviewContext {
  const cfg = requireKb(kb, configPath);
  const projects = Object.entries(cfg.projects)
    .filter(([name, pc]) => pc.path && subscribedKbs(cfg, name).includes(kb))
    .map(([name, pc]) => ({ name, root: resolveHome(pc.path) }));
  const { sources, errors } = loadSources(kbDir(cfg, kb));
  if (errors.length) throw new Error(`sources.yaml: ${errors.join("; ")}`);
  return { cfg, kb, sources, projects };
}

export function runKnowledgeReviewApply(kb: string, file: string, configPath = DEFAULT_CONFIG_PATH) {
  return applyDecisions(JSON.parse(fs.readFileSync(file, "utf8")) as DecisionFile, reviewContext(kb, configPath));
}
export function runKnowledgeResolve(kb: string, key: string, r: Resolution, by: string, reason: string, configPath = DEFAULT_CONFIG_PATH): string {
  return resolveEscalation(reviewContext(kb, configPath), key, r, by, reason);
}
export function runKnowledgePropose(kb: string, o: { statement: string; evidence: string; id?: string; domain?: string; modality?: RuleModality }, configPath = DEFAULT_CONFIG_PATH): string {
  return proposeAgentRule(reviewContext(kb, configPath), { ...o, agent: process.env.SQUADRANT_AGENT ?? "agent" });
}

knowledgeCommand
  .command("review <kb>")
  .description("Escalations for the operator (interactive walk-through); --json prints the reviewer packet; --apply applies reviewer decisions")
  .option("--json", "print the reviewer packet (proposals, stale rules, decided conflicts, open escalations)")
  .option("--apply <file>", "apply a reviewer decisions file (typed decisions + confidence); escalations are queued")
  .option("--resolve <key>", "answer one escalation non-interactively")
  .option("--approve", "with --resolve: approve / keep").option("--reject", "with --resolve: reject / drop")
  .option("--keep-doc", "with --resolve (code-vs-doc): keep the doc's rule").option("--supersede-with-code", "with --resolve (code-vs-doc): retire the rule in favour of the code")
  .option("--reason <text>", "reason recorded with the answer", "")
  .action(async (kb: string, o: { json?: boolean; apply?: string; resolve?: string; approve?: boolean; reject?: boolean; keepDoc?: boolean; supersedeWithCode?: boolean; reason: string }) => {
    if (o.json) { console.log(JSON.stringify(buildReviewPacket(reviewContext(kb, DEFAULT_CONFIG_PATH)), null, 2)); return; }
    if (o.apply) {
      const r = runKnowledgeReviewApply(kb, o.apply);
      console.log(`applied ${r.applied.length}, escalated ${r.escalated.length}, code violations ${r.violations.length}, skipped ${r.skipped.length}`);
      for (const e of r.escalated) console.log(chalk.yellow(`  ! ${e.key}: ${e.reasons.join(", ")}`));
      for (const x of r.skipped) console.log(chalk.red(`  ✘ ${x.item}: ${x.reason}`));
      return;
    }
    const by = os.userInfo().username;
    const resolution = (): Resolution | null =>
      o.keepDoc ? { kind: "verdict", verdict: "keep-doc" } : o.supersedeWithCode ? { kind: "verdict", verdict: "supersede-with-code" }
        : o.approve ? { kind: "approve" } : o.reject ? { kind: "reject" } : null;
    if (o.resolve) {
      const r = resolution();
      if (!r) throw new Error("--resolve needs --approve, --reject, --keep-doc or --supersede-with-code");
      console.log(runKnowledgeResolve(kb, o.resolve, r, by, o.reason));
      return;
    }
    const open = readEscalations(kbDir(requireKb(kb, DEFAULT_CONFIG_PATH), kb)).filter((e) => e.needsYou);
    if (!open.length) { console.log("Nothing needs you."); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const e of open) {
        console.log(`\n${chalk.bold(e.key)} [${e.kind}] ${e.reasons.join(", ")}\n${e.explanation}`);
        const codeVsDoc = e.kind === "code-vs-doc";
        const ans = (await rl.question(codeVsDoc ? "(k)eep doc / (s)upersede with code / (n)ext: " : "(a)pprove / (r)eject / (e)dit / (n)ext: ")).trim().toLowerCase();
        const reason = ans === "n" || !ans ? "" : await rl.question("reason: ");
        let r: Resolution | null = null;
        if (codeVsDoc) r = ans === "k" ? { kind: "verdict", verdict: "keep-doc" } : ans === "s" ? { kind: "verdict", verdict: "supersede-with-code" } : null;
        else if (ans === "a") r = { kind: "approve" };
        else if (ans === "r") r = { kind: "reject" };
        else if (ans === "e" && e.kind === "proposal") {
          const ctx = reviewContext(kb, DEFAULT_CONFIG_PATH);
          const file = path.join(kbRulesDir(ctx.cfg, kb), PROPOSED_DIR, `${e.item}.md`);
          spawnSync(process.env.EDITOR ?? "vi", [file], { stdio: "inherit" });
          r = { kind: "approve" };
        }
        if (r) console.log(chalk.green(runKnowledgeResolve(kb, e.key, r, by, reason)));
      }
    } finally { rl.close(); }
  });

knowledgeCommand
  .command("propose")
  .description("Propose a rule from what you learned (lands in _proposed/ with agent priority; never goes live unreviewed)")
  .requiredOption("--kb <kb>", "knowledge base")
  .requiredOption("--evidence <where>", "where you saw this (quote or pointer)")
  .option("--id <id>").option("--domain <slug>").option("--modality <m>", "must|must-not|should|may")
  .argument("<statement>", "the rule, one imperative sentence")
  .action((statement: string, o: { kb: string; evidence: string; id?: string; domain?: string; modality?: RuleModality }) => {
    console.log(`proposed: ${runKnowledgePropose(o.kb, { statement, ...o })}`);
  });

knowledgeCommand
  .command("reconcile <kb>")
  .description("Reconcile status; --now requests a pass from the home captain; --finish closes a pass (REPORT.md, schedule, captain message)")
  .option("--full", "full pass instead of incremental")
  .option("--now", "request the pass now instead of waiting for the schedule")
  .option("--dry-run", "show what would happen; write nothing")
  .option("--finish", "close the running pass (run by the reviewer crew when done)")
  .action(async (kb: string, o: { full?: boolean; now?: boolean; dryRun?: boolean; finish?: boolean }) => {
    const cfg = requireKb(kb, DEFAULT_CONFIG_PATH);
    const stateRoot = defaultStateRoot();
    const enqueue = (project: string, text: string) => appendCaptainMessage({ stateRoot, project, text, source: "cli", from: "knowledge" });
    const deps = { cfg, stateRoot, enqueue };
    if (o.finish) {
      if (o.dryRun) { console.log("dry run: would write REPORT.md, advance the schedule and message the captain"); return; }
      const r = await finishReconcile(kb, { ...deps, pass: o.full ? "full" : undefined });
      console.log(`${r.pass} pass closed; ${r.needsYou} need you; ${r.report}`);
      return;
    }
    if (o.now || o.dryRun) {
      const r = await requestPass(kb, o.full ? "full" : "incremental", deps, { dryRun: o.dryRun });
      console.log(r.requested ? `requested ${r.pass} pass from ${kbConfigsHome(kb)}` : `not requested: ${r.reason}`);
      if (!r.requested && !o.dryRun) process.exitCode = 1;
      return;
    }
    const e = readSchedule(stateRoot)[kb] ?? {};
    const due = duePass(e, { now: new Date(), rc: reconcileConfig(cfg, kb), empty: loadRules(cfg, kb, { includeProposed: true }).rules.length === 0 });
    console.log(JSON.stringify({ ...e, due }, null, 2));
  });

function kbConfigsHome(kb: string): string {
  return resolveKbConfig(loadConfig(), kb).homeProject ?? "(no homeProject)";
}

// ── feedback / stats / cite-scan (#901) ──────────────────────────────

export const FEEDBACK_OUTCOMES = ["followed", "violated", "noise", "wrong"] as const;
type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

/** Log an item.outcome for a rule the project resolves. Operator or agent may call it; `source` says who graded it (#945). */
export function runKnowledgeFeedback(
  id: string, outcome: FeedbackOutcome,
  o: { project?: string; audit?: AuditSink; env?: NodeJS.ProcessEnv; cwd?: string; source?: string; task?: string },
  configPath = DEFAULT_CONFIG_PATH,
): void {
  const source = (o.source ?? "operator") as OutcomeSource;
  if (!OUTCOME_SOURCES.includes(source)) throw new Error(`--source must be one of ${OUTCOME_SOURCES.join(", ")}, got '${o.source}'`);
  const cfg = loadConfig(configPath);
  const project = resolveRulesProject(cfg, o);
  const rule = resolveProjectRules(cfg, project).rules.find((r) => r.id === id);
  if (!rule) throw new Error(`No rule '${id}' for project '${project}'`);
  appendAudit([{
    ...ruleAuditScope(rule, cfg), project, domain: "rules", itemId: id, event: "item.outcome", outcome, source,
    ...(o.task ? { task: o.task } : {}), agent: (o.env ?? process.env).SQUADRANT_AGENT,
  }], o.audit);
}

knowledgeCommand
  .command("feedback <id>")
  .description("Report how a rule fared: --followed | --violated | --noise | --wrong (feeds scores and the next reconcile)")
  .option("--followed").option("--violated").option("--noise").option("--wrong")
  .option("--project <name>", "project (default: from cwd or SQUADRANT_CREW_PROJECT)")
  .option("--source <s>", `who graded it: ${OUTCOME_SOURCES.join(" | ")} (default operator)`)
  .option("--task <id>", "the crew task the grade is about (see: knowledge surfaced --task)")
  .action((id: string, o: Record<string, unknown> & { project?: string; source?: string; task?: string }) => {
    const picked = FEEDBACK_OUTCOMES.filter((k) => o[k]);
    if (picked.length !== 1) throw new Error("Pass exactly one of --followed, --violated, --noise, --wrong");
    runKnowledgeFeedback(id, picked[0], o);
    console.log(`recorded: ${id} ${picked[0]}`);
  });

export interface SurfacedItem { id: string; kb: string; project: string; modality: string; statement: string; events: string[] }

/** Rules delivered to one crew task (surfaced/shown/searched events carrying `task`), deduped, in first-delivery order. */
export function runKnowledgeSurfaced(task: string, o: { auditDir?: string } = {}, configPath = DEFAULT_CONFIG_PATH): SurfacedItem[] {
  const cfg = loadConfig(configPath);
  const rulesOf = new Map<string, Map<string, Rule>>();
  const lookup = (project: string, id: string): Rule | undefined => {
    if (!rulesOf.has(project)) {
      rulesOf.set(project, new Map(cfg.projects[project] ? resolveProjectRules(cfg, project).rules.map((r) => [r.id, r]) : []));
    }
    return rulesOf.get(project)!.get(id);
  };
  const out = new Map<string, SurfacedItem>();
  for (const r of readAuditRecords(undefined, new Date(0), o.auditDir)) {
    if (r.task !== task || !r.itemId || !DELIVERY_EVENTS.has(r.event ?? "")) continue;
    const project = r.project ?? "";
    const seen = out.get(r.itemId);
    if (seen) { if (!seen.events.includes(r.event!)) seen.events.push(r.event!); continue; }
    const rule = lookup(project, r.itemId);
    out.set(r.itemId, { id: r.itemId, kb: r.kb ?? "", project, modality: rule?.modality ?? "?", statement: rule?.statement ?? "(rule no longer resolves)", events: [r.event!] });
  }
  return [...out.values()];
}

export const renderSurfaced = (items: SurfacedItem[]): string[] =>
  items.length ? items.map((x) => `${x.id}  [${x.modality}]  ${x.statement}`) : ["(no rules delivered to this task)"];

knowledgeCommand
  .command("surfaced")
  .description("List the rules delivered to a crew task, for grading at review: knowledge feedback <id> --followed|--violated --source review --task <id>")
  .requiredOption("--task <id>", "crew task id")
  .option("--json")
  .action((o: { task: string; json?: boolean }) => {
    const items = runKnowledgeSurfaced(o.task);
    if (o.json) console.log(JSON.stringify(items, null, 2));
    else for (const l of renderSurfaced(items)) console.log(l);
  });

export interface StatsOpts { kb?: string; project?: string; domain?: string; item?: string; json?: boolean; auditDir?: string; now?: Date }

/** Scores per KB (all KBs, or the project's subscriptions, or one --kb), filtered by domain/item. */
export function runKnowledgeStats(o: StatsOpts, configPath = DEFAULT_CONFIG_PATH): Scores[] {
  const cfg = loadConfig(configPath);
  let kbs = Object.keys(kbConfigs(cfg));
  if (o.kb) kbs = [o.kb];
  else if (o.project) {
    if (!cfg.projects[o.project]) throw new Error(`Unknown project '${o.project}'`);
    kbs = subscribedKbs(cfg, o.project);
  }
  return kbs.map((kb) => {
    assertKbName(kb);
    const s = scoreKb({ kb, now: o.now ?? new Date(), auditDir: o.auditDir, kbRoot: kbDir(cfg, kb), known: loadRules(cfg, kb).rules.map((r) => ({ id: r.id, domain: "rules", status: r.status })) });
    return { ...s, items: s.items.filter((x) => (!o.domain || x.domain === o.domain) && (!o.item || x.itemId === o.item)), domains: s.domains.filter((d) => !o.domain || d.domain === o.domain) };
  });
}

export function renderStats(all: Scores[]): string[] {
  const pct = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)}%`);
  return all.flatMap((s) => [
    `${s.kb} (last ${s.windowDays} days)`,
    ...s.items.map((x) => `  ${x.itemId}  surfaced ${x.surfaced}  pulled ${x.pullRate}  cited ${x.cited}  use ${pct(x.useRate)}  noise ${pct(x.noiseRate)}  violated ${pct(x.violationRate)}${x.neverFired30d ? "  NEVER FIRED" : ""}`),
    ...s.domains.map((d) => `  domain ${d.domain}: writes ${d.writesPerMonth}/mo  reads ${d.readsPerMonth}/mo${d.deadDomain ? "  DEAD DOMAIN" : ""}`),
    `  agents: ${Object.entries(s.perAgentCoverage).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
  ]);
}

knowledgeCommand
  .command("stats")
  .description("Scores computed from the audit log: fire/pull/use/noise/violation rates, never-fired, per-domain activity")
  .option("--kb <kb>").option("--project <name>").option("--domain <slug>").option("--item <id>")
  .option("--json", "print scores.json-shaped output")
  .action((o: StatsOpts) => {
    const all = runKnowledgeStats(o);
    if (o.json) console.log(JSON.stringify(all, null, 2));
    else for (const l of renderStats(all)) console.log(l);
  });

export function runKnowledgeCiteScan(o: { project: string; text?: string; git?: string; sinceDays?: number; ref?: string; audit?: AuditSink; git_run?: (args: string[]) => string }): string[] {
  const run = o.git_run ?? ((args: string[]) => spawnSync("git", args, { encoding: "utf8" }).stdout ?? "");
  if (o.git) {
    const since = new Date((o.audit?.now?.() ?? new Date()).getTime() - (o.sinceDays ?? 30) * 86400000);
    return scanCitations(readGitMessages(o.git, since, run).map((c) => ({ text: c.text, ref: `git:${c.sha}`, at: c.at })), { project: o.project, sink: o.audit });
  }
  if (!o.text) throw new Error("Pass --text <message> or --git <repo>");
  return scanAndLogCitations({ text: o.text, ref: o.ref ?? "manual", project: o.project, sink: o.audit });
}

knowledgeCommand
  .command("cite-scan")
  .description("Log item.cited for rule ids named in a message (--text) or in recent commit messages (--git <repo>)")
  .requiredOption("--project <name>")
  .option("--text <message>").option("--git <repo>", "scan commit messages of this repo").option("--since-days <n>", "git lookback (default 30)", (v) => Number(v))
  .option("--ref <ref>", "dedup key for --text (default: manual)")
  .action((o: { project: string; text?: string; git?: string; sinceDays?: number; ref?: string }) => {
    const ids = runKnowledgeCiteScan(o);
    console.log(ids.length ? `cited: ${ids.join(", ")}` : "no new citations");
  });
