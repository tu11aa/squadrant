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
}

export interface KnowledgeKbConfig {
  /** KB repo root. Default: ~/squadrant/kb/<kb>. */
  path?: string;
  homeProject?: string;
  domainCap?: number;
  /** Optional allowed rule domains; `knowledge validate` warns on rules outside it. */
  domains?: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");

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
  if (fm.triggers !== undefined) {
    if (!isObj(fm.triggers)) p.push("triggers must be an object");
    else {
      for (const k of ["globs", "keywords", "expanded"] as const) {
        if (fm.triggers[k] !== undefined && !isStrArr(fm.triggers[k])) p.push(`triggers.${k} must be a string array`);
      }
      if (fm.triggers.when !== undefined && typeof fm.triggers.when !== "string") p.push("triggers.when must be a string");
    }
  }
  for (const k of ["supersedes", "conflictsWith"] as const) {
    if (fm[k] !== undefined && !isStrArr(fm[k])) p.push(`${k} must be a string array`);
  }
  if (!Array.isArray(fm.sources) || fm.sources.length === 0) {
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

/** The KB that holds the project's own items (KB spec §3 home resolution; auto-create is a later phase). */
export function homeKb(cfg: SquadrantConfig, project: string): string | undefined {
  const pc = cfg.projects[project];
  if (pc?.knowledgeHome?.startsWith("kb:")) return pc.knowledgeHome.slice(3);
  if (pc?.knowledgeHome) return undefined;
  return pc?.group ? cfg.groups?.[pc.group]?.kb : undefined;
}

/** KBs read for a project: its group's/home KB first, then `projects.<p>.knowledge[]`. A group KB is inherited. */
export function subscribedKbs(cfg: SquadrantConfig, project: string): string[] {
  const pc = cfg.projects[project];
  const group = pc?.group ? cfg.groups?.[pc.group]?.kb : undefined;
  return [...new Set([group, homeKb(cfg, project), ...(pc?.knowledge ?? [])].filter((k): k is string => !!k))];
}

/** Where the project's rule overlay lives: `<kb>/projects/<p>/rules`, or `<repo>/docs/rules` for `repo:docs`. */
export function projectRulesHome(cfg: SquadrantConfig, project: string): string | undefined {
  const pc = cfg.projects[project];
  if (pc?.knowledgeHome === "repo:docs") return path.join(resolveHome(pc.path), "docs", "rules");
  const kb = homeKb(cfg, project);
  return kb ? path.join(kbPath(cfg, kb), "projects", project, "rules") : undefined;
}

export function resolveKbConfig(cfg: SquadrantConfig, kb: string): { homeProject?: string; domainCap: number } {
  const explicit = kbConfigs(cfg)[kb] ?? {};
  const firstSubscriber = Object.keys(cfg.projects).find((p) => subscribedKbs(cfg, p).includes(kb));
  return {
    homeProject: explicit.homeProject ?? firstSubscriber,
    domainCap: explicit.domainCap ?? DEFAULT_DOMAIN_CAP,
  };
}
