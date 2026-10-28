// packages/shared/src/knowledge.ts
// #896 Rules KB — pure schema types + validators. Spec: docs/specs/2026-10-07-rules-kb-design.md §3.
import path from "node:path";
import { resolveHome, type SquadrantConfig } from "./config.js";

export type RuleModality = "must" | "must-not" | "should" | "may";
export type RuleStatus = "proposed" | "active" | "stale" | "retired";
export type RuleApprover = "auto" | "reviewer-agent" | "human";
export type SourcePriority = "company" | "project" | "agent";

export const RULE_MODALITIES: readonly RuleModality[] = ["must", "must-not", "should", "may"];
export const RULE_STATUSES: readonly RuleStatus[] = ["proposed", "active", "stale", "retired"];
export const SOURCE_PRIORITIES: readonly SourcePriority[] = ["company", "project", "agent"];
export const RULE_APPROVERS: readonly RuleApprover[] = ["auto", "reviewer-agent", "human"];
export const RULE_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const KB_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const DEFAULT_DOMAIN_CAP = 150;

export interface RuleSourceRef {
  ref: string;
  sha: string;
  loc?: string;
  /** Char span [start, end) in the converted source — used for mechanical id matching (#897). */
  offset?: [number, number];
  quote: string;
}

export interface RuleTriggers {
  globs?: string[];
  keywords?: string[];
  expanded?: string[];
  when?: string;
}

/** Per-project anchors, keyed by project name. */
export type RuleAnchors = Record<string, { paths?: string[]; symbols?: string[] }>;

export type RuleDecisionVerdict = "keep-doc" | "supersede-with-code";
/** The operator's recorded answer to a code-vs-doc conflict (#898 decision 2026-10-09). Evidence, not a status. */
export interface RuleDecision {
  by: string;
  at: string;
  verdict: RuleDecisionVerdict;
  /** What the doc / code looked like when judged; a change in either re-opens the question. */
  docRev: string;
  codeRev: string;
  files?: string[];
  reason: string;
}

export interface RuleFrontmatter {
  id: string;
  domain: string;
  modality: RuleModality;
  status: RuleStatus;
  triggers?: RuleTriggers;
  anchors?: RuleAnchors;
  sources: RuleSourceRef[];
  approvedBy?: RuleApprover;
  justification?: string;
  supersedes?: string[];
  conflictsWith?: string[];
  decision?: RuleDecision;
  /** Project overlay rules only: hash of the KB rule this one overrides, taken when the override was last confirmed. */
  overridesBase?: string;
}

export interface Rule extends RuleFrontmatter {
  /** First paragraph of the body. */
  statement: string;
  /** Full markdown body (statement + rationale). */
  body: string;
  /** Absolute path of the rule file. */
  file: string;
  /** Where it came from: `kb:<name>` or `project:<name>`. */
  layer: string;
}

export interface KnowledgeSourceEntry {
  path: string;
  priority: SourcePriority;
  domain?: string;
  sensitivity?: "local-only";
  /** `required`: new rules from this source wait in `_proposed/` for the operator (spec 2026-10-13 §5). Absent = auto-live (D4). */
  review?: "required";
}

/** One stale passage of a source, recorded in `<kb>/errata.yaml`. `apply` rejects candidates that overlap it (spec 2026-10-13 §4). */
export interface KnowledgeErratum {
  id: string;
  /** Source ref exactly as in rule `sources[].ref`. */
  ref: string;
  /** Verbatim passage that is out of date; located with the same grounding as rule quotes. */
  quote: string;
  reason: string;
  evidence?: string[];
  checked?: string;
  by?: string;
  at?: string;
  /** Optional decision record behind it. */
  decision?: string;
}

export interface ReconcileConfig {
  incrementalAfterDays: number;
  fullEveryDays: number;
  autoApproveConfidence: number;
}
export const DEFAULT_RECONCILE: ReconcileConfig = { incrementalAfterDays: 7, fullEveryDays: 30, autoApproveConfidence: 0.8 };

export interface KnowledgeKbConfig {
  /** Reconcile schedule + auto-approve threshold (#898); unset fields use DEFAULT_RECONCILE. */
  reconcile?: Partial<ReconcileConfig>;
  /** KB repo root. Default: ~/squadrant/kb/<kb>. */
  path?: string;
  homeProject?: string;
  domainCap?: number;
  /** Max sections handed to the extractor in one pass; the rest carries over (first-ingest guard, #897). Default 40. */
  maxSectionsPerPass?: number;
  /** Optional allowed rule domains; `knowledge validate` warns on rules outside it. */
  domains?: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Problems with a `triggers` block (rules and every other domain share the shape). */
function triggerProblems(t: unknown): string[] {
  if (t === undefined) return [];
  if (!isObj(t)) return ["triggers must be an object"];
  const p: string[] = [];
  for (const k of ["globs", "keywords", "expanded"] as const) {
    if (t[k] !== undefined && !isStrArr(t[k])) p.push(`triggers.${k} must be a string array`);
  }
  if (t.when !== undefined && typeof t.when !== "string") p.push("triggers.when must be a string");
  return p;
}

export function validateRuleFrontmatter(fm: unknown): string[] {
  if (!isObj(fm)) return ["frontmatter must be an object"];
  const p: string[] = [];
  if (typeof fm.id !== "string" || !RULE_ID_RE.test(fm.id)) p.push(`id must match ${RULE_ID_RE}`);
  if (typeof fm.domain !== "string" || !/^[a-z][a-z0-9-]*$/.test(fm.domain)) p.push("domain must be a lowercase slug");
  if (!RULE_MODALITIES.includes(fm.modality as RuleModality)) p.push(`modality must be one of ${RULE_MODALITIES.join("|")}`);
  if (!RULE_STATUSES.includes(fm.status as RuleStatus)) p.push(`status must be one of ${RULE_STATUSES.join("|")}`);
  if (fm.approvedBy !== undefined && !RULE_APPROVERS.includes(fm.approvedBy as RuleApprover)) {
    p.push(`approvedBy must be one of ${RULE_APPROVERS.join("|")}`);
  }
  p.push(...triggerProblems(fm.triggers));
  for (const k of ["supersedes", "conflictsWith"] as const) {
    if (fm[k] !== undefined && !isStrArr(fm[k])) p.push(`${k} must be a string array`);
  }
  // `knowledge sources --remove` leaves a stale/retired rule with no source; any other status needs one.
  const mayBeSourceless = fm.status === "stale" || fm.status === "retired";
  if (!Array.isArray(fm.sources) || (fm.sources.length === 0 && !mayBeSourceless)) {
    p.push("sources must be a non-empty array");
  } else {
    fm.sources.forEach((s, i) => {
      if (!isObj(s)) { p.push(`sources[${i}] must be an object`); return; }
      for (const k of ["ref", "sha", "quote"] as const) {
        if (typeof s[k] !== "string" || s[k] === "") p.push(`sources[${i}].${k} must be a non-empty string`);
      }
      if (s.offset !== undefined) {
        const o = s.offset;
        if (!Array.isArray(o) || o.length !== 2 || !o.every((n) => Number.isInteger(n) && n >= 0) || o[0] > o[1]) {
          p.push(`sources[${i}].offset must be [start, end] integers with start <= end`);
        }
      }
    });
  }
  return p;
}

export function validateSourceEntry(e: unknown): string[] {
  if (!isObj(e)) return ["source entry must be an object"];
  const p: string[] = [];
  if (typeof e.path !== "string" || e.path === "") p.push("path must be a non-empty string");
  if (!SOURCE_PRIORITIES.includes(e.priority as SourcePriority)) p.push(`priority must be one of ${SOURCE_PRIORITIES.join("|")}`);
  if (e.domain !== undefined && typeof e.domain !== "string") p.push("domain must be a string");
  if (e.sensitivity !== undefined && e.sensitivity !== "local-only") p.push("sensitivity must be 'local-only' when set");
  if (e.review !== undefined && e.review !== "required") p.push("review must be 'required' when set");
  return p;
}

export function validateErratum(e: unknown): string[] {
  if (!isObj(e)) return ["erratum must be an object"];
  const p: string[] = [];
  if (typeof e.id !== "string" || !RULE_ID_RE.test(e.id)) p.push(`id must match ${RULE_ID_RE}`);
  for (const k of ["ref", "quote", "reason"] as const) {
    if (typeof e[k] !== "string" || e[k] === "") p.push(`${k} must be a non-empty string`);
  }
  if (e.evidence !== undefined && !isStrArr(e.evidence)) p.push("evidence must be a string array");
  for (const k of ["checked", "by", "at", "decision"] as const) {
    if (e[k] !== undefined && typeof e[k] !== "string") p.push(`${k} must be a string`);
  }
  return p;
}

export const DEFAULT_KB_ROOT = "~/squadrant/kb";

/** Per-KB settings. `knowledge.<kb>` is the deprecated alias of `knowledgeBases.<kb>`; the new key wins. */
export function kbConfigs(cfg: SquadrantConfig): Record<string, KnowledgeKbConfig> {
  const out: Record<string, KnowledgeKbConfig> = { ...cfg.knowledge };
  for (const [kb, c] of Object.entries(cfg.knowledgeBases ?? {})) out[kb] = { ...out[kb], ...c };
  return out;
}

/** Absolute root of a KB repo. */
export function kbPath(cfg: SquadrantConfig, kb: string): string {
  return resolveHome(kbConfigs(cfg)[kb]?.path ?? `${DEFAULT_KB_ROOT}/${kb}`);
}

/** The operator profile KB (#982). Never a rules KB; `KB_NAME_RE` rejects the name on purpose. */
export const USER_KB = "_user";

/** Root of the `_user` KB: `SQUADRANT_USER_KB_DIR`, else `knowledgeBases._user.path`, else ~/squadrant/kb/_user. */
export function userKbDir(cfg?: SquadrantConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (env.SQUADRANT_USER_KB_DIR) return path.resolve(env.SQUADRANT_USER_KB_DIR);
  return cfg ? kbPath(cfg, USER_KB) : resolveHome(`${DEFAULT_KB_ROOT}/${USER_KB}`);
}

// ── KB phase 2 shared core (#979, spec 2026-10-27 §4) ────────────────

/** The four KB domains. The folder an item sits in decides its domain (D3). */
export const KB_DOMAINS = ["rules", "decisions", "wiki", "profile"] as const;
export type KbDomain = (typeof KB_DOMAINS)[number];
export const isKbDomain = (v: unknown): v is KbDomain => KB_DOMAINS.includes(v as KbDomain);
export type KbLevel = "shared" | "project";

/** D4: the id prefix each non-rules domain requires. A rule category may not be one of them. */
export const DOMAIN_ID_PREFIX: Readonly<Partial<Record<KbDomain, string>>> = { decisions: "dec", wiki: "wiki", profile: "prof" };
export const RESERVED_ID_PREFIXES: readonly string[] = Object.values(DOMAIN_ID_PREFIX);

/** One KB item of any domain (spec §4.1). Rules keep their own `Rule` type and adapt onto this. */
export interface KbItem {
  id: string;
  kbDomain: KbDomain;
  /** KB name (`_user` for profile); `repo:<project>` for a `repo:docs` home. */
  kb: string;
  level: KbLevel;
  /** Project-level items: the project whose home holds them. */
  project?: string;
  status: string;
  /** Normalized refs (`normalizeSourceRef`). */
  sources: string[];
  created?: string;
  updated?: string;
  /** One line: a trait/wiki `summary`, a rule's statement, a decision's title. */
  summary: string;
  body: string;
  triggers?: RuleTriggers;
  anchors?: RuleAnchors;
  /** Absolute path of the item file. */
  path: string;
  /** Read-set layer label, e.g. `acme/shared`, `acme/projects/projA`, `repo:projA`, `_user/profile`. */
  origin: string;
  /** Rules only: the frontmatter `domain`, which for rules is a category (D3). */
  category?: string;
}

export const SOURCE_REF_KINDS = ["artifact", "issue", "commit", "file", "raw", "memory", "session"] as const;

/**
 * One normal form for every `sources:` ref (#970): a rule's `RuleSourceRef` becomes its `ref`, a known kind prefix is
 * lowercased, `issue:893` becomes `issue:#893`. Free text (no known prefix) is kept, trimmed.
 */
export function normalizeSourceRef(src: string | RuleSourceRef): string {
  const ref = (typeof src === "string" ? src : src.ref).trim();
  const m = /^([A-Za-z]+):(.*)$/s.exec(ref);
  if (!m || !SOURCE_REF_KINDS.includes(m[1].toLowerCase() as (typeof SOURCE_REF_KINDS)[number])) return ref;
  const kind = m[1].toLowerCase();
  const rest = m[2].trim();
  return kind === "issue" && /^\d+$/.test(rest) ? `issue:#${rest}` : `${kind}:${rest}`;
}

/** D3 + D4 problems for an item file found under a `<domain>/` folder. Rule `domain:` is its category. */
export function validateItemDomain(fm: Record<string, unknown>, folder: KbDomain): string[] {
  const p: string[] = [];
  const id = typeof fm.id === "string" ? fm.id : "";
  const prefix = id.split(".")[0];
  if (folder === "rules") {
    if (typeof fm.domain === "string" && RESERVED_ID_PREFIXES.includes(fm.domain)) {
      p.push(`rule category '${fm.domain}' is reserved for the ${KB_DOMAINS.find((d) => DOMAIN_ID_PREFIX[d] === fm.domain)} domain (D4)`);
    }
    if (RESERVED_ID_PREFIXES.includes(prefix)) p.push(`rule id ${id} uses the reserved prefix '${prefix}.' (D4)`);
    return p;
  }
  if (fm.domain !== undefined && fm.domain !== folder) p.push(`domain '${String(fm.domain)}' does not match its folder '${folder}' (D3)`);
  const want = DOMAIN_ID_PREFIX[folder];
  if (want && prefix !== want) p.push(`id ${id || "(missing)"} must start with '${want}.' in ${folder}/ (D4)`);
  return p;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Common frontmatter fields (arch spec §4.1) of a decisions/wiki item. Rules and profile have their own validators. */
export function validateItemCommon(fm: Record<string, unknown>): string[] {
  const p: string[] = [];
  if (typeof fm.id !== "string" || !RULE_ID_RE.test(fm.id)) p.push(`id must match ${RULE_ID_RE}`);
  if (typeof fm.status !== "string" || !fm.status) p.push("status is required");
  if (fm.level !== undefined && fm.level !== "shared" && fm.level !== "project") p.push("level must be shared|project");
  if (!Array.isArray(fm.sources) || !fm.sources.every((s) => typeof s === "string")) p.push("sources must be a string array");
  for (const k of ["created", "updated"] as const) if (typeof fm[k] !== "string" || !DATE_RE.test(fm[k] as string)) p.push(`${k} must be a YYYY-MM-DD date`);
  p.push(...triggerProblems(fm.triggers));
  return p;
}

/** Auto-created home KB for projects with no group (D5 rule 4). */
export const PERSONAL_KB = "personal";

/** Where a project's own items live (D5). `pending-create` homes are created by the first write, never by a read. */
export type KnowledgeHome =
  | { kind: "kb"; kb: string; dir: (d: KbDomain) => string }
  | { kind: "repo"; dir: (d: KbDomain) => string }
  | { kind: "pending-create"; kb: string; dir: (d: KbDomain) => string };

const kbProjectDir = (cfg: SquadrantConfig, kb: string, project: string) => (d: KbDomain) => path.join(kbPath(cfg, kb), "projects", project, d);

/**
 * Home resolution (arch §3, D5): (1) `knowledgeHome` `kb:<name>` | `repo:docs`; (2) group mapped to a KB;
 * (3) group with no KB → a KB named after the group, pending; (4) no group → `personal`, pending until configured.
 * Undefined for an unknown project or an unrecognized `knowledgeHome`.
 */
export function resolveKnowledgeHome(cfg: SquadrantConfig, project: string): KnowledgeHome | undefined {
  const pc = cfg.projects[project];
  if (!pc) return undefined;
  if (pc.knowledgeHome?.startsWith("kb:")) {
    const kb = pc.knowledgeHome.slice(3);
    return { kind: "kb", kb, dir: kbProjectDir(cfg, kb, project) };
  }
  if (pc.knowledgeHome === "repo:docs") return { kind: "repo", dir: (d) => path.join(resolveHome(pc.path), "docs", d) };
  if (pc.knowledgeHome) return undefined;
  if (pc.group) {
    const kb = cfg.groups?.[pc.group]?.kb;
    if (kb) return { kind: "kb", kb, dir: kbProjectDir(cfg, kb, project) };
    // A KB already registered under the group's name (e.g. after `knowledge init <group>`) is that home, as for `personal`.
    return { kind: kbConfigs(cfg)[pc.group] ? "kb" : "pending-create", kb: pc.group, dir: kbProjectDir(cfg, pc.group, project) };
  }
  const kind = kbConfigs(cfg)[PERSONAL_KB] ? "kb" : "pending-create";
  return { kind, kb: PERSONAL_KB, dir: kbProjectDir(cfg, PERSONAL_KB, project) };
}

/** The `kb` a project-level audit event carries: the home KB, `repo:<project>` for `repo:docs`, else "" (no home yet, C4). */
export function homeAuditKb(cfg: SquadrantConfig, project: string): string {
  const h = resolveKnowledgeHome(cfg, project);
  return h?.kind === "kb" ? h.kb : h?.kind === "repo" ? `repo:${project}` : "";
}

/** The KB that holds the project's own items, when it exists (thin wrapper over resolveKnowledgeHome). */
export function homeKb(cfg: SquadrantConfig, project: string): string | undefined {
  const h = resolveKnowledgeHome(cfg, project);
  return h?.kind === "kb" ? h.kb : undefined;
}

/** KBs read for a project: its group's/home KB first, then `projects.<p>.knowledge[]`. A group KB is inherited. */
export function subscribedKbs(cfg: SquadrantConfig, project: string): string[] {
  const pc = cfg.projects[project];
  const group = pc?.group ? cfg.groups?.[pc.group]?.kb : undefined;
  return [...new Set([group, homeKb(cfg, project), ...(pc?.knowledge ?? [])].filter((k): k is string => !!k))];
}

/** Where the project's rule overlay lives: `<kb>/projects/<p>/rules`, or `<repo>/docs/rules` for `repo:docs`. */
export function projectRulesHome(cfg: SquadrantConfig, project: string): string | undefined {
  const h = resolveKnowledgeHome(cfg, project);
  return h && h.kind !== "pending-create" ? h.dir("rules") : undefined;
}

/** One layer of a project's read set: the folder holding its `<domain>/` dirs. */
export interface ReadLayer {
  /** KB name, `_user`, or `repo:<project>`. */
  kb: string;
  level: KbLevel;
  /** The dir that holds `<domain>/` folders. */
  root: string;
  /** Label shown in the merged view: `acme/shared`, `acme/projects/projA`, `repo:projA`, `_user/profile`. */
  origin: string;
  /** Project-level layers: the project. */
  project?: string;
  /** Domains this layer can hold (`_user`: profile only; KB layers: the other three). */
  domains: readonly KbDomain[];
}

const KB_LAYER_DOMAINS: readonly KbDomain[] = ["rules", "decisions", "wiki"];

/**
 * Read set (arch §3), in order: `_user/profile` → group KB `shared/` → home KB `shared/` → home →
 * each `projects.<p>.knowledge[]` KB's `shared/`. A pending-create home contributes nothing. Never creates anything.
 */
export function knowledgeReadSet(cfg: SquadrantConfig, project: string, env: NodeJS.ProcessEnv = process.env): ReadLayer[] {
  const pc = cfg.projects[project];
  if (!pc) return [];
  const layers: ReadLayer[] = [{ kb: USER_KB, level: "shared", root: userKbDir(cfg, env), origin: `${USER_KB}/profile`, domains: ["profile"] }];
  const shared = (kb: string): ReadLayer => ({ kb, level: "shared", root: path.join(kbPath(cfg, kb), "shared"), origin: `${kb}/shared`, domains: KB_LAYER_DOMAINS });
  const home = resolveKnowledgeHome(cfg, project);
  const before = [...new Set([pc.group ? cfg.groups?.[pc.group]?.kb : undefined, homeKb(cfg, project)].filter((k): k is string => !!k))];
  for (const kb of before) layers.push(shared(kb));
  if (home?.kind === "kb") {
    layers.push({ kb: home.kb, level: "project", project, root: path.dirname(home.dir("rules")), origin: `${home.kb}/projects/${project}`, domains: KB_LAYER_DOMAINS });
  } else if (home?.kind === "repo") {
    layers.push({ kb: `repo:${project}`, level: "project", project, root: path.dirname(home.dir("rules")), origin: `repo:${project}`, domains: KB_LAYER_DOMAINS });
  }
  for (const kb of subscribedKbs(cfg, project)) if (!before.includes(kb)) layers.push(shared(kb));
  return layers;
}

export function resolveKbConfig(cfg: SquadrantConfig, kb: string): { homeProject?: string; domainCap: number } {
  const explicit = kbConfigs(cfg)[kb] ?? {};
  const firstSubscriber = Object.keys(cfg.projects).find((p) => subscribedKbs(cfg, p).includes(kb));
  return {
    homeProject: explicit.homeProject ?? firstSubscriber,
    domainCap: explicit.domainCap ?? DEFAULT_DOMAIN_CAP,
  };
}
