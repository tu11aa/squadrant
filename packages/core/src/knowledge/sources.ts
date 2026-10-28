import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import matter from "gray-matter";
import { validateSourceEntry, type KnowledgeSourceEntry, type RuleFrontmatter } from "@squadrant/shared";
import { compileIndex, writeIndex } from "./index-file.js";
import { sourceCovers } from "./ingest.js";
import { loadRulesDir } from "./store.js";
import { commitKbPaths, kbSession } from "./write.js";

export const SOURCES_TEMPLATE = `# Trusted sources for this knowledge base (spec §3). Only these can produce rules.
# priority: company > project > agent (decides conflicts).
# sensitivity: local-only  → never sent to a hosted model (D12).
# review: required         → new rules from this source wait in rules/_proposed/ for the operator; they never go live on their own.
#
# - path: raw/finance/**
#   priority: company
# - path: ~/work/flooros/docs/handbook/**
#   priority: project
#   domain: coding
# - path: raw/**
#   priority: agent
#   review: required
[]
`;

export function loadSources(kbRoot: string): { sources: KnowledgeSourceEntry[]; errors: string[] } {
  const file = path.join(kbRoot, "sources.yaml");
  if (!fs.existsSync(file)) return { sources: [], errors: [] };
  let data: unknown;
  try {
    data = yaml.load(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { sources: [], errors: [`YAML parse error: ${(e as Error).message.split("\n")[0]}`] };
  }
  if (data == null) return { sources: [], errors: [] };
  if (!Array.isArray(data)) return { sources: [], errors: ["sources.yaml must be a YAML list of entries"] };
  const sources: KnowledgeSourceEntry[] = [];
  const errors: string[] = [];
  data.forEach((entry, i) => {
    const problems = validateSourceEntry(entry);
    if (problems.length) errors.push(...problems.map((p) => `entry ${i}: ${p}`));
    else sources.push(entry as KnowledgeSourceEntry);
  });
  return { sources, errors };
}

export interface RemoveSourceResult {
  dryRun: boolean;
  entryRemoved: boolean;
  /** Rules that lost at least one ref. */
  stripped: string[];
  /** Of those, the ones left with no source (now `stale`, or unchanged if already stale/retired). */
  stale: string[];
  /** Commit failures: the files stand (`knowledge doctor --fix`). */
  warnings: string[];
}

/** Drop the `- path: <entry>` block from sources.yaml text, keeping comments and the other entries. Null if it is not a plain block entry. */
function dropEntryBlock(text: string, entryPath: string): string | null {
  const lines = text.split("\n");
  const q = entryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^-\\s+path:\\s*(['"]?)${q}\\1\\s*(#.*)?$`);
  const i = lines.findIndex((l) => head.test(l));
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && /^\s+\S/.test(lines[j])) j++;
  return [...lines.slice(0, i), ...lines.slice(j)].join("\n");
}

/**
 * `knowledge sources <kb> --remove <path>`: strip every rule ref the entry covers, mark rules left with no source `stale`
 * (still delivered until the reviewer retires them), drop the entry from sources.yaml, recompile the index.
 * Rules with another source stay as they are. Proposals in `_proposed/` are not touched.
 */
export function removeSource(kbRoot: string, rulesDir: string, entryPath: string, opts: { dryRun?: boolean; kbName?: string } = {}): RemoveSourceResult {
  const file = path.join(kbRoot, "sources.yaml");
  const { sources } = loadSources(kbRoot);
  const entry = sources.find((s) => s.path === entryPath);
  if (!entry) throw new Error(`no sources.yaml entry with path '${entryPath}' (give it exactly as listed by \`knowledge sources\`)`);
  const edited = dropEntryBlock(fs.readFileSync(file, "utf8"), entryPath);
  if (edited === null) throw new Error(`could not edit sources.yaml for '${entryPath}' (not a plain block entry); remove it by hand, then rerun to strip the refs`);

  const res: RemoveSourceResult = { dryRun: !!opts.dryRun, entryRemoved: true, stripped: [], stale: [], warnings: [] };
  const writes: { file: string; text: string }[] = [];
  for (const rule of loadRulesDir(rulesDir, "kb").rules) {
    const kept = rule.sources.filter((s) => !sourceCovers(kbRoot, sources, entry, s.ref));
    if (kept.length === rule.sources.length) continue;
    res.stripped.push(rule.id);
    const parsed = matter(fs.readFileSync(rule.file, "utf8"), { engines: { javascript: () => { throw new Error("only YAML front matter is allowed"); } } });
    const fm = { ...(parsed.data as RuleFrontmatter), sources: kept };
    if (!kept.length) {
      res.stale.push(rule.id);
      if (fm.status === "active") fm.status = "stale";
    }
    writes.push({ file: rule.file, text: matter.stringify(parsed.content, JSON.parse(JSON.stringify(fm)) as object) });
  }
  res.stripped.sort();
  res.stale.sort();
  if (opts.dryRun) return res;

  for (const w of writes) fs.writeFileSync(w.file, w.text);
  fs.writeFileSync(file, edited);
  const name = opts.kbName ?? path.basename(kbRoot);
  writeIndex(kbRoot, compileIndex(name, loadRulesDir(rulesDir, `kb:${name}`).rules));
  const c = commitKbPaths(kbRoot, [file, ...writes.map((w) => w.file)], {
    message: `knowledge: remove source ${entryPath}`,
    trailers: { domain: "rules", items: res.stripped, level: "shared", session: kbSession(), approvedBy: "operator" },
  });
  if (c.warning) res.warnings.push(c.warning);
  return res;
}
