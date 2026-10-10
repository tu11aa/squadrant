// packages/core/src/knowledge/anchor.ts — per-project anchors (rules spec §4 step 6, #897).
// Searches a project's repo for a rule's keywords + expanded terms and records where they occur.
import fs from "node:fs";
import path from "node:path";
import type { RuleAnchors, RuleTriggers } from "@squadrant/shared";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".worktrees", ".planning", ".converted"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php", ".cs", ".sol", ".sql", ".md"]);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PATHS = 5;
const MAX_SYMBOLS = 10;
const SYMBOL_RE = /\b(?:function|class|interface|type|const|let|var|enum|def|fn|struct)\s+([A-Za-z_]\w*)/g;

export const anchorTerms = (t?: RuleTriggers): string[] =>
  [...new Set([...(t?.keywords ?? []), ...(t?.expanded ?? [])].map((s) => s.toLowerCase().trim()).filter((s) => s.length >= 3))].sort();

function* repoFiles(root: string): Generator<string> {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? 1 : -1)); } catch { continue; }
    for (const ent of ents) {
      if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) stack.push(path.join(dir, ent.name)); }
      else if (ent.isFile() && CODE_EXT.has(path.extname(ent.name))) {
        if (++count > MAX_FILES) return;
        yield path.join(dir, ent.name);
      }
    }
  }
}

/** Deterministic: top files by distinct-term hits (ties by path), plus symbols whose names contain a term. */
export function computeAnchor(repoRoot: string, triggers?: RuleTriggers): RuleAnchors[string] | null {
  const terms = anchorTerms(triggers);
  if (!terms.length || !fs.existsSync(repoRoot)) return null;
  const hits: { rel: string; score: number; symbols: string[] }[] = [];
  for (const file of repoFiles(repoRoot)) {
    let text: string;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(file, "utf8");
    } catch { continue; }
    const hay = `${path.relative(repoRoot, file)}\n${text}`.toLowerCase();
    const score = terms.filter((t) => hay.includes(t)).length;
    if (!score) continue;
    const symbols = [...text.matchAll(SYMBOL_RE)].map((m) => m[1]).filter((s) => terms.some((t) => s.toLowerCase().includes(t)));
    hits.push({ rel: path.relative(repoRoot, file).split(path.sep).join("/"), score, symbols });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : 1));
  const top = hits.slice(0, MAX_PATHS);
  const symbols = [...new Set(top.flatMap((h) => h.symbols))].sort().slice(0, MAX_SYMBOLS);
  return { paths: top.map((h) => h.rel).sort(), ...(symbols.length ? { symbols } : {}) };
}
