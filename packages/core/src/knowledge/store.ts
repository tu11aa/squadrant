// packages/core/src/knowledge/store.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { validateRuleFrontmatter, type KnowledgeSourceEntry, type Rule, type RuleFrontmatter } from "@squadrant/shared";
import { PROPOSED_DIR } from "./paths.js";

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
        if (ent.name === PROPOSED_DIR && !includeProposed) continue;
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

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

/** Candidate files for a rule's source ref: as-is, under the KB dir, or under any ancestor of a declared source path. */
function resolveSourceRef(ref: string, kbRoot: string, sources: KnowledgeSourceEntry[]): string | undefined {
  const bases = new Set<string>([kbRoot]);
  for (const s of sources) {
    let d = path.resolve(kbRoot, expandHome(s.path.split(/[*?[{]/)[0]));
    for (let i = 0; i < 6 && d !== path.dirname(d); i++) { d = path.dirname(d); bases.add(d); }
  }
  const cands = [path.resolve(kbRoot, expandHome(ref)), ...[...bases].map((b) => path.join(b, ref))];
  return cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
}

/** CI-style KB check: invalid files, duplicate ids, quote-in-source, optional allowed domains. */
export function validateKb(opts: {
  rulesDir: string; kbRoot: string; sources: KnowledgeSourceEntry[]; domains?: string[];
}): { checks: KbCheck[]; ok: boolean } {
  const { rules, errors } = loadRulesDir(opts.rulesDir, "kb", { includeProposed: true });
  const checks: KbCheck[] = [];
  const dups = errors.filter((e) => e.problems.some((p) => p.startsWith("duplicate id")));
  const invalid = errors.filter((e) => !dups.includes(e));
  const proposed = rules.filter((r) => path.relative(opts.rulesDir, r.file).split(path.sep).includes(PROPOSED_DIR)).length;
  checks.push({ level: "ok", message: `${rules.length + errors.length} rule files read (${rules.length - proposed} live, ${proposed} proposed parsed OK)` });
  if (invalid.length) for (const e of invalid) checks.push({ level: "fail", message: `invalid ${e.file}: ${e.problems.join("; ")}` });
  else checks.push({ level: "ok", message: "no invalid rule files" });
  if (dups.length) for (const e of dups) checks.push({ level: "fail", message: e.problems.join("; ") });
  else checks.push({ level: "ok", message: "no duplicate ids" });

  const cache = new Map<string, string | null>();
  let verified = 0, unresolved = 0;
  for (const r of rules) {
    r.sources.forEach((src, i) => {
      const file = resolveSourceRef(src.ref, opts.kbRoot, opts.sources);
      if (!file) { unresolved++; return; }
      if (!cache.has(file)) cache.set(file, fs.readFileSync(file, "utf8"));
      if (cache.get(file)!.includes(src.quote)) verified++;
      else checks.push({ level: "fail", message: `quote not found in ${file}: ${r.id} sources[${i}] (${r.file})` });
    });
  }
  if (!checks.some((c) => c.message.startsWith("quote not found"))) checks.push({ level: "ok", message: `${verified} source quotes found in their source files` });
  if (unresolved) checks.push({ level: "skip", message: `${unresolved} source refs not resolvable on this machine, quote not checked` });

  if (opts.domains) {
    for (const r of rules) {
      if (!opts.domains.includes(r.domain)) checks.push({ level: "warn", message: `${r.id}: domain '${r.domain}' not in allowed domains [${opts.domains.join(", ")}] (${r.file})` });
    }
  }
  return { checks, ok: !checks.some((c) => c.level === "fail") };
}
