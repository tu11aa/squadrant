// packages/core/src/knowledge/anchor.ts — per-project anchors (rules spec §4 step 6, #897).
// Searches a project's repo for a rule's keywords + expanded terms and records where they occur.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { RuleAnchors, RuleTriggers } from "@squadrant/shared";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".worktrees", ".planning", ".converted", ".venv", "venv", "__pycache__"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php", ".cs", ".sol", ".sql", ".md"]);
// Safety cap only: with a git file list the scan is bounded; memory is bounded by MAX_FILE_BYTES per file.
const MAX_FILES = 20000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PATHS = 5;
const MAX_SYMBOLS = 10;
const SYMBOL_RE = /\b(?:function|class|interface|type|const|let|var|enum|def|fn|struct)\s+([A-Za-z_]\w*)/g;

export const anchorTerms = (t?: RuleTriggers): string[] =>
  [...new Set([...(t?.keywords ?? []), ...(t?.expanded ?? [])].map((s) => s.toLowerCase().trim()).filter((s) => s.length >= 3))].sort();

/** Tracked + untracked-but-not-ignored files, or null when root isn't a git repo / git fails. */
function gitFiles(root: string): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    return out.split("\0").filter(Boolean).sort();
  } catch { return null; }
}

function* repoFiles(root: string, maxFiles: number): Generator<string> {
  let count = 0;
  const listed = gitFiles(root);
  if (listed) {
    for (const rel of listed) {
      if (!CODE_EXT.has(path.extname(rel)) || rel.split("/").slice(0, -1).some((d) => SKIP_DIRS.has(d))) continue;
      if (++count > maxFiles) { console.warn(`anchor: ${root} has more than ${maxFiles} code files; anchors cover only the first ${maxFiles}`); return; }
      yield path.join(root, rel);
    }
    return;
  }
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? 1 : -1)); } catch { continue; }
    for (const ent of ents) {
      if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) stack.push(path.join(dir, ent.name)); }
      else if (ent.isFile() && CODE_EXT.has(path.extname(ent.name))) {
        if (++count > maxFiles) { console.warn(`anchor: ${root} has more than ${maxFiles} code files; anchors cover only the first ${maxFiles}`); return; }
        yield path.join(dir, ent.name);
      }
    }
  }
}

interface ScannedFile { rel: string; text: string; hay: string }
/** Per-root scan results. Create one per apply/review pass and drop it after — never keep it process-wide. */
export type AnchorCache = Map<string, ScannedFile[]>;

function scanRepo(root: string, maxFiles: number): ScannedFile[] {
  const out: ScannedFile[] = [];
  for (const file of repoFiles(root, maxFiles)) {
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      const text = fs.readFileSync(file, "utf8");
      const rel = path.relative(root, file).split(path.sep).join("/");
      out.push({ rel, text, hay: `${path.relative(root, file)}\n${text}`.toLowerCase() });
    } catch { continue; }
  }
  return out;
}

/** Deterministic: top files by distinct-term hits (ties by path), plus symbols whose names contain a term. */
export function computeAnchor(repoRoot: string, triggers?: RuleTriggers, cache?: AnchorCache, maxFiles = MAX_FILES): RuleAnchors[string] | null {
  const terms = anchorTerms(triggers);
  if (!terms.length || !fs.existsSync(repoRoot)) return null;
  let files = cache?.get(repoRoot);
  if (!files) { files = scanRepo(repoRoot, maxFiles); cache?.set(repoRoot, files); }
  const hits: { rel: string; score: number; text: string }[] = [];
  for (const { rel, text, hay } of files) {
    const score = terms.filter((t) => hay.includes(t)).length;
    if (!score) continue;
    hits.push({ rel, score, text });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : 1));
  const top = hits.slice(0, MAX_PATHS);
  const symbols = [...new Set(top.flatMap((h) => [...h.text.matchAll(SYMBOL_RE)].map((m) => m[1]).filter((s) => terms.some((t) => s.toLowerCase().includes(t)))))].sort().slice(0, MAX_SYMBOLS);
  return { paths: top.map((h) => h.rel).sort(), ...(symbols.length ? { symbols } : {}) };
}
