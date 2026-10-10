// packages/core/src/knowledge/match.ts — T0 structural matching + injection budget (#899, rules spec §6).
// Glob and anchor (path/symbol) hits are exact, so they rank before the lexical scorer in search.ts.
import path from "node:path";
import type { Rule } from "@squadrant/shared";
import { globToRegExp } from "./ingest.js";

/** ≈800 tokens of rule lines and at most 5 rules per injection (spec §6). */
export const INJECT_MAX_RULES = 5;
export const INJECT_MAX_CHARS = 3200;

export type StructuralVia = "glob" | "anchor";
export interface StructuralHit { rule: Rule; via: StructuralVia }

export function globMatches(glob: string, relPath: string): boolean {
  const g = glob.replace(/^\.\//, "");
  if (globToRegExp(g).test(relPath)) return true;
  return !g.includes("/") && globToRegExp(g).test(path.posix.basename(relPath));
}

/** Repo-relative forms of a file path: against cwd and against the project root, minus a `.worktrees/<crew>/` prefix. */
export function repoRelativePaths(file: string, cwd: string, projectRoot: string): string[] {
  const out = new Set<string>();
  const add = (base: string) => {
    const rel = path.relative(base, file).split(path.sep).join("/");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
    out.add(rel);
    const wt = /^\.worktrees\/[^/]+\/(.+)$/.exec(rel);
    if (wt) out.add(wt[1]);
  };
  if (path.isAbsolute(file)) { add(cwd); add(projectRoot); } else out.add(file.replace(/^\.\//, ""));
  return [...out];
}

/** Rules whose globs match, or whose anchors for this project name, one of the paths. Glob before anchor. */
export function matchPaths(rules: Rule[], project: string, relPaths: string[]): StructuralHit[] {
  const hits: StructuralHit[] = [];
  for (const rule of rules) {
    if (rule.status !== "active") continue;
    if (rule.triggers?.globs?.some((g) => relPaths.some((p) => globMatches(g, p)))) hits.push({ rule, via: "glob" });
    else if (rule.anchors?.[project]?.paths?.some((a) => relPaths.includes(a))) hits.push({ rule, via: "anchor" });
  }
  return hits;
}

/** Rules whose anchored symbols appear as whole identifiers in the text (e.g. `computeTotal`). */
export function matchSymbols(rules: Rule[], project: string, text: string): StructuralHit[] {
  const idents = new Set(text.match(/[A-Za-z_$][\w$]{2,}/g) ?? []);
  return rules.filter((r) => r.status === "active" && r.anchors?.[project]?.symbols?.some((s) => idents.has(s)))
    .map((rule) => ({ rule, via: "anchor" as const }));
}

/** File-looking tokens in prompt text (`src/a/b.ts`, `foo.sol`). */
export function mentionedPaths(text: string): string[] {
  const found = text.match(/[\w@.\-/]*[\w-]\.[A-Za-z]{1,5}\b|[\w.-]+\/[\w./-]+/g) ?? [];
  return [...new Set(found.map((f) => f.replace(/^\.\//, "")))].slice(0, 20);
}

/** First `maxRules` rules whose lines fit `maxChars`; the rest are overflow. */
export function applyBudget<T extends { rule: Rule }>(
  items: T[], lineLen: (r: Rule) => number, maxRules = INJECT_MAX_RULES, maxChars = INJECT_MAX_CHARS,
): { shown: T[]; overflow: T[] } {
  const shown: T[] = [];
  let chars = 0;
  for (const it of items) {
    const n = lineLen(it.rule);
    if (shown.length >= maxRules || (shown.length > 0 && chars + n > maxChars)) break;
    shown.push(it);
    chars += n;
  }
  return { shown, overflow: items.slice(shown.length) };
}
