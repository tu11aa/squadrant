// packages/core/src/knowledge/fullpass.ts — the extra work of a full reconcile pass (rules spec §5, #898):
// dedup candidates, usage review (from the #935 audit log), domain cap, override.base-changed.
// All mechanical; judgement (classifying pairs) belongs to the reviewer.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { projectRulesHome, resolveKbConfig, subscribedKbs, type Rule, type SquadrantConfig } from "@squadrant/shared";
import { defaultAuditDir } from "./audit.js";
import { loadKbRules } from "./layers.js";
import { addEscalation, type Escalation } from "./review.js";
import { kbDir } from "./paths.js";
import { loadRulesDir } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const NEVER_SURFACED_DAYS = 30;
export const NOISY_MIN_SURFACED = 5;
export const NOISY_RATE = 0.5;
export const MAX_DEDUP_PAIRS = 50;

const terms = (r: Rule) => new Set([...(r.triggers?.keywords ?? []), ...(r.triggers?.expanded ?? [])].map((s) => s.toLowerCase()));

/** Active rule pairs sharing >= 2 trigger terms or an anchor path: candidates for the reviewer's duplicate/refines/conflicts call. */
export function dedupPairs(rules: Rule[]): { a: string; b: string; shared: string[] }[] {
  const active = rules.filter((r) => r.status === "active").sort((x, y) => x.id.localeCompare(y.id));
  const out: { a: string; b: string; shared: string[] }[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const ta = terms(active[i]), shared = [...terms(active[j])].filter((t) => ta.has(t));
      const pa = new Set(Object.values(active[i].anchors ?? {}).flatMap((a) => a.paths ?? []));
      const sharedPaths = Object.values(active[j].anchors ?? {}).flatMap((a) => a.paths ?? []).filter((p) => pa.has(p));
      if (shared.length >= 2 || sharedPaths.length) out.push({ a: active[i].id, b: active[j].id, shared: [...shared, ...sharedPaths] });
    }
  }
  return out.slice(0, MAX_DEDUP_PAIRS);
}

export interface AuditRecord { ts: string; kb?: string; itemId?: string; event?: string; outcome?: string; [k: string]: unknown }

/** Read audit lines for one KB at or after `since`; unreadable lines are skipped. */
export function readAuditRecords(kb: string, since: Date, dir = defaultAuditDir()): AuditRecord[] {
  if (!fs.existsSync(dir)) return [];
  const sinceMonth = since.toISOString().slice(0, 7);
  const out: AuditRecord[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl") && n.slice(0, 7) >= sinceMonth).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line) as AuditRecord; if (e.kb === kb && Date.parse(e.ts) >= since.getTime()) out.push(e); } catch { /* skip */ }
    }
  }
  return out;
}

export interface UsageReview {
  surfaced: Record<string, number>;
  neverSurfaced: string[];
  noisy: string[];
  violated: string[];
}
/** Never-surfaced → re-check triggers; noisy → narrow triggers; violated → reword. */
export function usageReview(rules: Rule[], events: AuditRecord[]): UsageReview {
  const surfaced: Record<string, number> = {};
  const noise: Record<string, number> = {};
  const violated = new Set<string>();
  for (const e of events) {
    if (!e.itemId) continue;
    if (e.event === "item.surfaced") surfaced[e.itemId] = (surfaced[e.itemId] ?? 0) + 1;
    if (e.event === "item.outcome") {
      if (e.outcome === "noise") noise[e.itemId] = (noise[e.itemId] ?? 0) + 1;
      if (e.outcome === "violated") violated.add(e.itemId);
    }
  }
  const active = rules.filter((r) => r.status === "active");
  return {
    surfaced,
    neverSurfaced: active.filter((r) => !surfaced[r.id]).map((r) => r.id).sort(),
    noisy: Object.keys(noise).filter((id) => (surfaced[id] ?? 0) >= NOISY_MIN_SURFACED && noise[id] / surfaced[id] >= NOISY_RATE).sort(),
    violated: [...violated].sort(),
  };
}

/** Domains over the cap, with the archive candidates (least surfaced, then oldest id order) needed to get back under it. */
export function domainCapExcess(rules: Rule[], cap: number, surfaced: Record<string, number>): { domain: string; count: number; cap: number; candidates: string[] }[] {
  const byDomain = new Map<string, Rule[]>();
  for (const r of rules.filter((x) => x.status === "active")) byDomain.set(r.domain, [...(byDomain.get(r.domain) ?? []), r]);
  return [...byDomain].filter(([, rs]) => rs.length > cap).map(([domain, rs]) => ({
    domain, count: rs.length, cap,
    candidates: [...rs].sort((a, b) => (surfaced[a.id] ?? 0) - (surfaced[b.id] ?? 0) || a.id.localeCompare(b.id)).slice(0, rs.length - cap).map((r) => r.id),
  }));
}

/** What an override was written against: changes when the KB rule's meaning or sources change. */
export const baseHash = (r: Rule): string =>
  crypto.createHash("sha256").update(JSON.stringify([r.modality, r.statement, r.sources.map((s) => s.sha)])).digest("hex").slice(0, 12);

export interface OverrideFinding { project: string; ruleId: string; file: string; baseHash: string; changed: boolean }
/** Project-overlay rules whose id matches a KB rule are overrides. The first pass stamps the baseline; later passes compare. */
export function checkOverrides(cfg: SquadrantConfig, kb: string): OverrideFinding[] {
  const base = new Map(loadKbRules(cfg, kb).rules.map((r) => [r.id, r]));
  const out: OverrideFinding[] = [];
  for (const project of Object.keys(cfg.projects)) {
    if (!subscribedKbs(cfg, project).includes(kb)) continue;
    const dir = projectRulesHome(cfg, project);
    if (!dir) continue;
    for (const o of loadRulesDir(dir, `project:${project}`).rules) {
      const b = base.get(o.id);
      if (!b) continue;
      const h = baseHash(b);
      if (!o.overridesBase) {
        const m = matter(fs.readFileSync(o.file, "utf8"));
        fs.writeFileSync(o.file, matter.stringify(m.content, { ...m.data, overridesBase: h }));
        continue;
      }
      out.push({ project, ruleId: o.id, file: o.file, baseHash: h, changed: o.overridesBase !== h });
    }
  }
  return out;
}

export interface FullPassFindings {
  usage: UsageReview;
  caps: ReturnType<typeof domainCapExcess>;
  overrides: OverrideFinding[];
}

/** Mechanical full-pass checks; domain-cap and override.base-changed become escalations. */
export function runFullChecks(cfg: SquadrantConfig, kb: string, o: { now: Date; auditDir?: string }): FullPassFindings {
  const rules = loadKbRules(cfg, kb).rules;
  const kbRoot = kbDir(cfg, kb);
  const usage = usageReview(rules, readAuditRecords(kb, new Date(o.now.getTime() - NEVER_SURFACED_DAYS * DAY_MS), o.auditDir));
  const caps = domainCapExcess(rules, resolveKbConfig(cfg, kb).domainCap, usage.surfaced);
  const overrides = checkOverrides(cfg, kb).filter((f) => f.changed);
  const base = { createdAt: o.now.toISOString(), needsYou: true };
  for (const c of caps) {
    addEscalation(kbRoot, { ...base, key: `domain-cap:${c.domain}`, kind: "domain-cap", reasons: ["domain cap"], explanation: `Domain '${c.domain}' has ${c.count} active rules (cap ${c.cap}). Archive candidates (least surfaced): ${c.candidates.join(", ")}.` } satisfies Escalation);
  }
  for (const f of overrides) {
    addEscalation(kbRoot, { ...base, key: `override:${f.project}:${f.ruleId}`, kind: "override-base-changed", ruleId: f.ruleId, item: f.file, reasons: ["override.base-changed"], explanation: `Project ${f.project} overrides ${f.ruleId}, but the KB rule changed since the override was confirmed. Keep the override (approve) or drop it (reject).`, evidence: { docRev: f.baseHash, codeRev: "", files: [], project: f.project } });
  }
  return { usage, caps, overrides };
}
