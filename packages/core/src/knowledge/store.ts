// packages/core/src/knowledge/store.ts
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { validateRuleFrontmatter, type KnowledgeErratum, type KnowledgeSourceEntry, type Rule, type RuleFrontmatter } from "@squadrant/shared";
import { convertedFile, PASS_THROUGH, readState, refCanon, resolveSourceRef } from "./ingest.js";
import { PROPOSED_DIR } from "./paths.js";
import { ARCHIVE_DIR } from "./profile.js";
import { findQuote, normalizedViews, spansOverlap, type Normalized } from "./verify.js";

// gray-matter evals `---js` front matter by default; rule files are untrusted, so allow YAML only.
const NO_JS_FRONTMATTER = {
  engines: { javascript: { parse: (): never => { throw new Error("only YAML front matter is allowed"); } } },
};

export interface RuleLoadError { file: string; problems: string[] }
export interface RuleLoadResult { rules: Rule[]; errors: RuleLoadError[] }

/** Names both files, which one is used, and how to fix it. Live files beat _proposed, then path order decides. */
export function duplicateIdProblem(id: string, ignored: string, used: string): string {
  return `duplicate id ${id}: ${ignored} is ignored, ${used} is used (live files win over _proposed, then path order). `
    + "Fix: rename the id in one file, or delete or move one of them.";
}

/** A `_proposed/<id>@<sha>.md` sharing its id with a live rule is a pending meaning change (D5), not a defect. */
export function isPendingProposalDup(e: RuleLoadError, rulesDir: string): boolean {
  return e.problems.every((p) => p.startsWith("duplicate id"))
    && path.relative(rulesDir, e.file).split(path.sep).includes(PROPOSED_DIR);
}

export function splitStatement(body: string): string {
  const first = body.trim().split(/\n\s*\n/)[0] ?? "";
  return first.replace(/\s+/g, " ").trim();
}

function listMarkdown(dir: string, includeProposed: boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if ((ent.name === PROPOSED_DIR && !includeProposed) || ent.name === ARCHIVE_DIR) continue; // archived items are never live (#979 §4.1)
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith(".md")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  // Live rules first so a live id always beats a _proposed duplicate; path order within each group.
  const isProposed = (f: string) => path.relative(dir, f).split(path.sep).includes(PROPOSED_DIR);
  return out.sort((a, b) => Number(isProposed(a)) - Number(isProposed(b)) || (a < b ? -1 : a > b ? 1 : 0));
}

export function loadRulesDir(dir: string, layer: string, opts: { includeProposed?: boolean } = {}): RuleLoadResult {
  if (!fs.existsSync(dir)) return { rules: [], errors: [] };
  const rules: Rule[] = [];
  const errors: RuleLoadError[] = [];
  const seen = new Map<string, string>();
  for (const file of listMarkdown(dir, opts.includeProposed ?? false)) {
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(fs.readFileSync(file, "utf8"), NO_JS_FRONTMATTER);
    } catch (e) {
      errors.push({ file, problems: [`frontmatter parse error: ${(e as Error).message}`] });
      continue;
    }
    const problems = validateRuleFrontmatter(parsed.data);
    if (problems.length) { errors.push({ file, problems }); continue; }
    const fm = parsed.data as RuleFrontmatter;
    const prior = seen.get(fm.id);
    if (prior) { errors.push({ file, problems: [duplicateIdProblem(fm.id, file, prior)] }); continue; }
    seen.set(fm.id, file);
    rules.push({ ...fm, statement: splitStatement(parsed.content), body: parsed.content.trim(), file, layer });
  }
  return { rules, errors };
}

export interface KbCheck { level: "ok" | "fail" | "warn" | "skip"; message: string }

/** CI-style KB check: invalid files, duplicate ids, quote-in-source, optional allowed domains. */
export function validateKb(opts: {
  rulesDir: string; kbRoot: string; sources: KnowledgeSourceEntry[]; domains?: string[]; errata?: KnowledgeErratum[];
}): { checks: KbCheck[]; ok: boolean } {
  const { rules, errors } = loadRulesDir(opts.rulesDir, "kb", { includeProposed: true });
  const checks: KbCheck[] = [];
  const dups = errors.filter((e) => e.problems.some((p) => p.startsWith("duplicate id")) && !isPendingProposalDup(e, opts.rulesDir));
  const pendingDups = errors.filter((e) => isPendingProposalDup(e, opts.rulesDir)).length;
  const invalid = errors.filter((e) => !dups.includes(e) && !isPendingProposalDup(e, opts.rulesDir));
  const proposed = rules.filter((r) => path.relative(opts.rulesDir, r.file).split(path.sep).includes(PROPOSED_DIR)).length;
  checks.push({ level: "ok", message: `${rules.length + errors.length} rule files read (${rules.length - proposed} live, ${proposed + pendingDups} proposed parsed OK)` });
  if (invalid.length) for (const e of invalid) checks.push({ level: "fail", message: `invalid ${e.file}: ${e.problems.join("; ")}` });
  else checks.push({ level: "ok", message: "no invalid rule files" });
  if (dups.length) for (const e of dups) checks.push({ level: "fail", message: e.problems.join("; ") });
  else checks.push({ level: "ok", message: "no duplicate ids" });

  // Ground against the same text `knowledge apply` used: the converted cache when ingested, else the original.
  const cache = new Map<string, { hay: Normalized[]; convertible: boolean }>();
  const canon = refCanon(opts.kbRoot, opts.sources);
  let verified = 0, unresolved = 0, notIngested = 0;
  for (const r of rules) {
    r.sources.forEach((src, i) => {
      const file = resolveSourceRef(opts.kbRoot, opts.sources, src.ref);
      if (!file) { unresolved++; return; }
      const key = `${src.ref}\0${file}`;
      if (!cache.has(key)) {
        const conv = readState(opts.kbRoot, canon(src.ref)) ? convertedFile(opts.kbRoot, canon(src.ref)) : null;
        const cached = !!conv && fs.existsSync(conv);
        cache.set(key, {
          hay: normalizedViews(fs.readFileSync(cached ? conv! : file, "utf8")),
          convertible: !cached && !PASS_THROUGH.has(path.extname(file).toLowerCase()),
        });
      }
      const { hay, convertible } = cache.get(key)!;
      const span = findQuote(hay, src.quote);
      if (span) {
        verified++;
        const active = r.status === "active" && !path.relative(opts.rulesDir, r.file).split(path.sep).includes(PROPOSED_DIR);
        const err = active ? (opts.errata ?? []).find((e) => canon(e.ref) === canon(src.ref) && ((o) => !!o && spansOverlap(o, span))(findQuote(hay, e.quote))) : undefined;
        if (err) checks.push({ level: "warn", message: `${r.id}: grounded in erratum ${err.id} (${err.reason}); re-check or retire it (${r.file})` });
      }
      else if (convertible) notIngested++;
      else checks.push({ level: "fail", message: `quote not found in ${file}: ${r.id} sources[${i}] (${r.file})` });
    });
  }
  if (!checks.some((c) => c.message.startsWith("quote not found"))) checks.push({ level: "ok", message: `${verified} source quotes found in their source files` });
  if (notIngested) checks.push({ level: "skip", message: `${notIngested} source refs need conversion but have no .converted cache, quote not checked (run \`squadrant knowledge ingest <kb>\`)` });
  if (unresolved) checks.push({ level: "skip", message: `${unresolved} source refs not resolvable on this machine, quote not checked` });

  if (opts.domains) {
    for (const r of rules) {
      if (!opts.domains.includes(r.domain)) checks.push({ level: "warn", message: `${r.id}: domain '${r.domain}' not in allowed domains [${opts.domains.join(", ")}] (${r.file})` });
    }
  }
  return { checks, ok: !checks.some((c) => c.level === "fail") };
}
