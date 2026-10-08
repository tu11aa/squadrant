// packages/core/src/knowledge/store.ts
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { validateRuleFrontmatter, type Rule, type RuleFrontmatter } from "@squadrant/shared";
import { PROPOSED_DIR } from "./paths.js";

// gray-matter evals `---js` front matter by default; rule files are untrusted, so allow YAML only.
const NO_JS_FRONTMATTER = {
  engines: { javascript: { parse: (): never => { throw new Error("only YAML front matter is allowed"); } } },
};

export interface RuleLoadError { file: string; problems: string[] }
export interface RuleLoadResult { rules: Rule[]; errors: RuleLoadError[] }

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
  return out.sort();
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
    if (prior) { errors.push({ file, problems: [`duplicate id ${fm.id} (also in ${prior})`] }); continue; }
    seen.set(fm.id, file);
    rules.push({ ...fm, statement: splitStatement(parsed.content), body: parsed.content.trim(), file, layer });
  }
  return { rules, errors };
}
