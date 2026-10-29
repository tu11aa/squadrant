// packages/core/src/knowledge/items.ts — the shared read side of every KB domain (#979, spec 2026-10-27 §4.1–4.3).
// One loader per `<level>/<domain>/` folder, adapted onto KbItem; rules and profile keep their own parsers.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  kbConfigs, kbPath, knowledgeReadSet, normalizeSourceRef, userKbDir, validateItemCommon, validateItemDomain, USER_KB,
  type KbDomain, type KbItem, type ReadLayer, type Rule, type SquadrantConfig,
} from "@squadrant/shared";
import { PROPOSED_DIR } from "./paths.js";
import { loadRulesDir, splitStatement, type RuleLoadError } from "./store.js";
import { ARCHIVE_DIR, loadProfile, splitFrontmatter, type Trait } from "./profile.js";

export interface ItemLoadResult { items: KbItem[]; errors: RuleLoadError[] }

const skipped = (dir: string, f: string) => path.relative(dir, f).split(path.sep).some((s) => s === PROPOSED_DIR || s === ARCHIVE_DIR);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

/** Item files under `dir`, recursing, minus `_proposed/` and `_archive/`. Inside a git repo, gitignored files are skipped (#971). */
export function listItemFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  let files: string[];
  try {
    const out = execFileSync("git", ["-C", dir, "ls-files", "-co", "--exclude-standard", "-z", "--", "."],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    files = out.split("\0").filter(Boolean).map((r) => path.join(dir, r)).filter((f) => fs.existsSync(f));
  } catch {
    files = walk(dir);
  }
  return files.filter((f) => f.endsWith(".md") && !skipped(dir, f)).sort();
}

const firstHeading = (body: string) => /^#\s+(.+)$/m.exec(body)?.[1].trim();

export function ruleToItem(r: Rule, layer: ReadLayer): KbItem {
  return {
    id: r.id, kbDomain: "rules", kb: layer.kb, level: layer.level, ...(layer.project ? { project: layer.project } : {}),
    status: r.status, sources: r.sources.map(normalizeSourceRef), summary: r.statement, body: r.body,
    ...(r.triggers ? { triggers: r.triggers } : {}), ...(r.anchors ? { anchors: r.anchors } : {}),
    path: r.file, origin: layer.origin, category: r.domain,
  };
}

export function traitToItem(t: Trait & { file: string }): KbItem {
  return {
    id: t.id, kbDomain: "profile", kb: USER_KB, level: "shared", status: t.status, sources: t.sources.map(normalizeSourceRef),
    created: t.created, updated: t.updated, summary: t.summary, body: t.body, ...(t.triggers ? { triggers: t.triggers } : {}),
    path: t.file, origin: `${USER_KB}/profile`,
  };
}

/** Decisions and wiki: common fields + D3 + D4; summary = frontmatter `summary`, else the first `# ` heading, else the first paragraph. */
function loadGenericDir(dir: string, domain: KbDomain, layer: ReadLayer): ItemLoadResult {
  const res: ItemLoadResult = { items: [], errors: [] };
  for (const file of listItemFiles(dir)) {
    let s: ReturnType<typeof splitFrontmatter>;
    try { s = splitFrontmatter(fs.readFileSync(file, "utf8")); } catch (e) { res.errors.push({ file, problems: [`frontmatter parse error: ${(e as Error).message}`] }); continue; }
    if (!s) { res.errors.push({ file, problems: ["missing YAML frontmatter"] }); continue; }
    const fm = s.fm;
    const problems = [...validateItemCommon(fm), ...validateItemDomain(fm, domain)];
    if (problems.length) { res.errors.push({ file, problems }); continue; }
    const body = s.body.trim();
    res.items.push({
      id: fm.id as string, kbDomain: domain, kb: layer.kb, level: layer.level, ...(layer.project ? { project: layer.project } : {}),
      status: fm.status as string, sources: (fm.sources as string[]).map(normalizeSourceRef),
      created: fm.created as string, updated: fm.updated as string,
      summary: typeof fm.summary === "string" && fm.summary.trim() ? fm.summary.trim() : firstHeading(body) ?? splitStatement(body),
      body, ...(fm.triggers && typeof fm.triggers === "object" ? { triggers: fm.triggers as KbItem["triggers"] } : {}),
      path: file, origin: layer.origin,
    });
  }
  return res;
}

/** Live items of one domain in one read-set layer. Rules go through the Phase 1 loader unchanged. */
export function loadLayerDomain(layer: ReadLayer, domain: KbDomain): ItemLoadResult {
  if (!layer.domains.includes(domain)) return { items: [], errors: [] };
  if (domain === "profile") {
    const p = loadProfile(layer.root);
    return { items: p.active.map(traitToItem), errors: p.errors };
  }
  const dir = path.join(layer.root, domain);
  if (domain === "rules") {
    const res = loadRulesDir(dir, layer.level === "project" ? `project:${layer.project}` : `kb:${layer.kb}`);
    return { items: res.rules.map((r) => ruleToItem(r, layer)), errors: res.errors };
  }
  return loadGenericDir(dir, domain, layer);
}

export interface ReadSetResult {
  /** Winning items, sorted by id. */
  items: KbItem[];
  /** Items hidden by a project-level item with the same id. */
  overridden: { item: KbItem; by: KbItem }[];
  errors: RuleLoadError[];
  warnings: string[];
  layers: ReadLayer[];
}

/**
 * The merged view of a project's read set (spec §4.3). Shared layers: first wins (later ones are shadowed, as in
 * `resolveProjectRules`); the project home overrides shared items. `rulesDisabled` hides rules. Never creates anything.
 */
export function resolveReadSet(
  cfg: SquadrantConfig, project: string, o: { domains?: readonly KbDomain[]; env?: NodeJS.ProcessEnv } = {},
): ReadSetResult {
  const pc = cfg.projects[project];
  if (!pc) throw new Error(`Unknown project '${project}'`);
  const layers = knowledgeReadSet(cfg, project, o.env);
  const byId = new Map<string, KbItem>();
  const res: ReadSetResult = { items: [], overridden: [], errors: [], warnings: [], layers };
  for (const layer of layers) {
    if (layer.kb !== USER_KB && layer.level === "shared" && !fs.existsSync(path.dirname(layer.root))) {
      res.warnings.push(`knowledge base '${layer.kb}' not found (run: squadrant knowledge init ${layer.kb})`);
      continue;
    }
    for (const domain of o.domains ?? layer.domains) {
      const got = loadLayerDomain(layer, domain);
      res.errors.push(...got.errors);
      for (const item of got.items) {
        const prior = byId.get(item.id);
        if (prior && layer.level === "project") res.overridden.push({ item: prior, by: item });
        else if (prior) { res.warnings.push(`item '${item.id}' in ${item.origin} shadowed by ${prior.origin}`); continue; }
        byId.set(item.id, item);
      }
    }
  }
  for (const id of (o.domains ?? ["rules"]).includes("rules") ? pc.rulesDisabled ?? [] : []) {
    if (byId.get(id)?.kbDomain === "rules") byId.delete(id);
    else res.warnings.push(`rulesDisabled: unknown rule id '${id}'`);
  }
  res.items = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return res;
}

/** Every layer stored in one KB: `shared/` plus each `projects/<p>/`. `_user` is its profile layer. */
export function kbLayers(cfg: SquadrantConfig, kb: string, env: NodeJS.ProcessEnv = process.env): ReadLayer[] {
  if (kb === USER_KB) return [{ kb, level: "shared", root: userKbDir(cfg, env), origin: `${USER_KB}/profile`, domains: ["profile"] }];
  const root = kbPath(cfg, kb);
  const domains: readonly KbDomain[] = ["rules", "decisions", "wiki"];
  const layers: ReadLayer[] = [{ kb, level: "shared", root: path.join(root, "shared"), origin: `${kb}/shared`, domains }];
  let projects: string[] = [];
  try { projects = fs.readdirSync(path.join(root, "projects"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { /* none */ }
  for (const p of projects) layers.push({ kb, level: "project", project: p, root: path.join(root, "projects", p), origin: `${kb}/projects/${p}`, domains });
  return layers;
}

/** Every live item stored in a KB, all domains and levels (scoring's `known` set, spec §4.5). */
export function loadKbItems(cfg: SquadrantConfig, kb: string, env: NodeJS.ProcessEnv = process.env): ItemLoadResult {
  const res: ItemLoadResult = { items: [], errors: [] };
  for (const layer of kbLayers(cfg, kb, env)) {
    for (const d of layer.domains) {
      const got = loadLayerDomain(layer, d);
      res.items.push(...got.items);
      res.errors.push(...got.errors);
    }
  }
  return res;
}

/** The KBs `knowledge stats` / doctor cover: every configured KB plus `_user`. */
export function allKbNames(cfg: SquadrantConfig): string[] {
  return [...new Set([...Object.keys(kbConfigs(cfg)), USER_KB])];
}

/**
 * `knowledge doctor` item checks (spec §4.1): every file in every domain folder of the KB, including `_proposed/`,
 * checked for D3 (folder vs frontmatter `domain`) and D4 (reserved id prefixes), plus each domain's own validation.
 */
export function validateKbItems(cfg: SquadrantConfig, kb: string, env: NodeJS.ProcessEnv = process.env): RuleLoadError[] {
  const out: RuleLoadError[] = [];
  for (const layer of kbLayers(cfg, kb, env)) {
    for (const domain of layer.domains) {
      const dir = path.join(layer.root, domain);
      if (!fs.existsSync(dir)) continue;
      const files = walk(dir).filter((f) => f.endsWith(".md") && !path.relative(dir, f).split(path.sep).includes(ARCHIVE_DIR));
      for (const file of files) {
        let s: ReturnType<typeof splitFrontmatter>;
        try { s = splitFrontmatter(fs.readFileSync(file, "utf8")); } catch (e) { out.push({ file, problems: [`frontmatter parse error: ${(e as Error).message}`] }); continue; }
        if (!s) { out.push({ file, problems: ["missing YAML frontmatter"] }); continue; }
        const problems = validateItemDomain(s.fm, domain);
        if (domain === "decisions" || domain === "wiki") problems.unshift(...validateItemCommon(s.fm));
        if (problems.length) out.push({ file, problems });
      }
    }
  }
  return out;
}
