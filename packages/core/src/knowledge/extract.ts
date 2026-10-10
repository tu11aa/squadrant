// packages/core/src/knowledge/extract.ts — everything after the LLM step (rules spec §4 steps 4-7, #897):
// verify quotes, match ids by offset overlap, classify the change, write rules/proposals, anchor, compile.
// The candidates come from the `knowledge-extract` skill; no model is called here.
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  RULE_ID_RE, RULE_MODALITIES, type Rule, type RuleAnchors, type RuleFrontmatter, type RuleModality, type RuleSourceRef, type RuleTriggers,
} from "@squadrant/shared";
import { appendAudit, type AuditEvent, type AuditSink } from "./audit.js";
import { computeAnchor } from "./anchor.js";
import { compileIndex, writeIndex } from "./index-file.js";
import { convertedFile, readState } from "./ingest.js";
import { PROPOSED_DIR } from "./paths.js";
import { loadRulesDir } from "./store.js";
import { findQuote, needsDocling, normalizeText, normalizedViews, spansOverlap, type Normalized } from "./verify.js";

export interface Candidate {
  /** Source ref exactly as listed in the ingest plan. */
  source: string;
  /** The model's id choice; overridden when the quote overlaps an existing rule's offset. */
  id: string;
  domain: string;
  modality: RuleModality;
  statement: string;
  rationale?: string;
  quote: string;
  loc?: string;
  triggers?: RuleTriggers;
  /** For an existing id: did the meaning change? Defaults to "changed" (the safe side, spec D5). */
  meaning?: "same" | "changed";
  /** Ids of active rules this candidate contradicts. */
  contradicts?: string[];
}
export interface CandidateFile {
  /** Refs for which this file holds the *complete* candidate set; only these can mark rules stale. */
  complete?: string[];
  candidates: Candidate[];
}

export interface ApplyOptions {
  kb: string;
  kbRoot: string;
  rulesDir: string;
  /** Subscribed projects to anchor against (name → repo root). Empty ⇒ anchors skipped. */
  projects?: { name: string; root: string }[];
  audit?: AuditSink;
  now?: () => Date;
}
export interface ApplyResult {
  created: string[];
  merged: string[];
  proposed: string[];
  superseded: string[];
  stale: string[];
  rejected: { id: string; source: string; reason: string }[];
  /** Sources where >20% of candidates were dropped: conversion likely poor. */
  doclingFlags: { ref: string; dropped: number; total: number }[];
  /** id the model chose → id actually used, when the offset matcher overrode it. */
  idOverrides: { from: string; to: string }[];
}

type Fm = RuleFrontmatter & Record<string, unknown>;
interface Work { fm: Fm; body: string; file: string; dirty: boolean; isNew: boolean }

const SHA_LEN = 12;
const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function serialize(fm: Fm, body: string): string {
  return matter.stringify(body.trim() + "\n", clean(fm));
}

export function validateCandidate(c: Partial<Candidate>): string[] {
  const p: string[] = [];
  if (typeof c.source !== "string" || !c.source) p.push("source must be a non-empty string");
  if (typeof c.id !== "string" || !RULE_ID_RE.test(c.id)) p.push(`id must match ${RULE_ID_RE}`);
  if (typeof c.domain !== "string" || !/^[a-z][a-z0-9-]*$/.test(c.domain)) p.push("domain must be a lowercase slug");
  if (!RULE_MODALITIES.includes(c.modality as RuleModality)) p.push(`modality must be one of ${RULE_MODALITIES.join("|")}`);
  if (typeof c.statement !== "string" || !c.statement.trim()) p.push("statement must be non-empty");
  if (typeof c.quote !== "string" || !c.quote.trim()) p.push("quote must be non-empty");
  const t = c.triggers;
  if (t !== undefined) {
    for (const k of ["globs", "keywords", "expanded"] as const) {
      const v = t[k];
      if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) p.push(`triggers.${k} must be a string array`);
    }
    for (const g of t.globs ?? []) { if (typeof g === "string" && /^\s*$/.test(g)) p.push("triggers.globs entries must be non-empty"); }
  }
  return p;
}

const sameMeaning = (existing: Work, c: Candidate): boolean => {
  if (existing.fm.modality !== c.modality) return false;
  if (normalizeText(existing.body.trim().split(/\n\s*\n/)[0] ?? "") === normalizeText(c.statement)) return true;
  return c.meaning === "same";
};

function upsertSource(fm: Fm, src: RuleSourceRef): boolean {
  const i = fm.sources.findIndex((s) => s.ref === src.ref);
  if (i < 0) { fm.sources.push(src); return true; }
  if (JSON.stringify(fm.sources[i]) === JSON.stringify(src)) return false;
  fm.sources[i] = src;
  return true;
}

export function applyCandidates(input: CandidateFile, opts: ApplyOptions): ApplyResult {
  const { kb, kbRoot, rulesDir } = opts;
  const res: ApplyResult = { created: [], merged: [], proposed: [], superseded: [], stale: [], rejected: [], doclingFlags: [], idOverrides: [] };
  const events: AuditEvent[] = [];
  const ev = (event: AuditEvent["event"], itemId: string, domain: string, extra: Partial<AuditEvent> = {}) =>
    events.push({ kb, level: "group", project: "", domain, itemId, event, ...extra });

  const loaded = loadRulesDir(rulesDir, `kb:${kb}`);
  const work = new Map<string, Work>();
  for (const r of loaded.rules) {
    const { statement: _s, body, file, layer: _l, ...fm } = r as Rule;
    work.set(r.id, { fm: fm as Fm, body, file, dirty: false, isNew: false });
  }

  const norm = new Map<string, Normalized[]>();
  const totals = new Map<string, { total: number; dropped: number }>();
  const touched = new Set<string>();
  const complete = new Set(input.complete ?? []);

  for (const cand of input.candidates) {
    const problems = validateCandidate(cand);
    if (problems.length) { res.rejected.push({ id: String(cand.id), source: String(cand.source), reason: `invalid: ${problems.join("; ")}` }); continue; }
    const st = readState(kbRoot, cand.source);
    const convFile = st ? convertedFile(kbRoot, cand.source) : null;
    if (!st || !fs.existsSync(convFile!)) {
      res.rejected.push({ id: cand.id, source: cand.source, reason: "unknown source (not ingested)" });
      continue;
    }
    let hay = norm.get(cand.source);
    if (!hay) { hay = normalizedViews(fs.readFileSync(convFile!, "utf8")); norm.set(cand.source, hay); }

    const tot = totals.get(cand.source) ?? { total: 0, dropped: 0 };
    tot.total++;
    totals.set(cand.source, tot);

    const offset = findQuote(hay, cand.quote);
    if (!offset) {
      tot.dropped++;
      res.rejected.push({ id: cand.id, source: cand.source, reason: "ungrounded" });
      ev("item.rejected", cand.id, cand.domain, { reason: "ungrounded" });
      continue;
    }

    // Mechanical id matching: offset overlap in the same source beats the model's id.
    let id = cand.id;
    for (const [wid, w] of work) {
      // Offsets were taken against the sha at extraction time; once the source changed, re-find the stored quote in the new text (an edited quote is gone, so keep its old span).
      const span = (s: RuleSourceRef) => (s.sha === st.sha ? s.offset : findQuote(hay!, s.quote) ?? s.offset);
      if (w.fm.sources.some((s) => s.ref === cand.source && s.offset && ((o) => !!o && spansOverlap(o, offset))(span(s)))) { id = wid; break; }
    }
    if (id !== cand.id) res.idOverrides.push({ from: cand.id, to: id });
    touched.add(id);

    const src: RuleSourceRef = { ref: cand.source, sha: st.sha, ...(cand.loc ? { loc: cand.loc } : {}), offset, quote: cand.quote.trim() };
    const target = work.get(id);
    const contradicted = (cand.contradicts ?? []).filter((x) => work.has(x) && x !== id);
    const bodyOf = () => cand.statement.trim() + (cand.rationale?.trim() ? `\n\n${cand.rationale.trim()}` : "");

    if (target && contradicted.length === 0 && sameMeaning(target, cand)) {
      let changed = upsertSource(target.fm, src);
      if (target.fm.status === "stale") { target.fm.status = "active"; changed = true; }
      if (changed) { target.dirty = true; res.merged.push(id); }
      continue;
    }

    if (!target && contradicted.length === 0) {
      const fm: Fm = {
        id, domain: cand.domain, modality: cand.modality, status: "active",
        ...(cand.triggers ? { triggers: cand.triggers } : {}),
        sources: [src], approvedBy: "auto", justification: "", supersedes: [], conflictsWith: [],
      };
      work.set(id, { fm, body: bodyOf(), file: path.join(rulesDir, cand.domain, `${id}.md`), dirty: true, isNew: true });
      res.created.push(id);
      ev("item.applied", id, cand.domain);
      continue;
    }

    // Meaning change (D5) or contradiction: old version stays active, the new one waits in _proposed/.
    const fm: Fm = {
      id, domain: target?.fm.domain ?? cand.domain, modality: cand.modality, status: "proposed",
      ...(cand.triggers ?? target?.fm.triggers ? { triggers: cand.triggers ?? target?.fm.triggers } : {}),
      sources: [src], approvedBy: "reviewer-agent", justification: "", supersedes: [],
      conflictsWith: contradicted,
    };
    const dir = path.join(rulesDir, PROPOSED_DIR);
    const file = path.join(dir, `${id}@${st.sha.slice(0, SHA_LEN)}.md`);
    const text = serialize(fm, bodyOf());
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) continue;
    fs.mkdirSync(dir, { recursive: true });
    for (const other of fs.readdirSync(dir)) {
      if (!other.startsWith(`${id}@`) || !other.endsWith(".md") || path.join(dir, other) === file) continue;
      const old = matter(fs.readFileSync(path.join(dir, other), "utf8"));
      if (!(old.data.sources as RuleSourceRef[] | undefined)?.some((s) => s.ref === cand.source)) continue;
      // Source changed again while a proposal was pending: close the older one, classify this one afresh.
      fs.writeFileSync(path.join(dir, other.replace(/\.md$/, ".superseded")), matter.stringify(old.content, { ...old.data, supersededBy: path.basename(file) }));
      fs.rmSync(path.join(dir, other));
      res.superseded.push(other.replace(/\.md$/, ""));
      ev("item.superseded", id, fm.domain);
    }
    fs.writeFileSync(file, text);
    res.proposed.push(`${id}@${st.sha.slice(0, SHA_LEN)}`);
    ev("item.proposed", id, fm.domain);
  }

  // A rule whose every source was fully re-swept this pass, but which no candidate matched, is stale.
  for (const [id, w] of work) {
    if (touched.has(id) || w.fm.status !== "active" || w.isNew) continue;
    if (w.fm.sources.length && w.fm.sources.every((s) => complete.has(s.ref))) {
      w.fm.status = "stale";
      w.dirty = true;
      res.stale.push(id);
    }
  }

  // Per-project anchors for every rule written this pass.
  for (const w of work.values()) {
    if (!w.dirty || !opts.projects?.length) continue;
    const anchors: RuleAnchors = { ...(w.fm.anchors ?? {}) };
    for (const p of opts.projects) {
      const a = computeAnchor(p.root, w.fm.triggers);
      if (a) anchors[p.name] = a;
    }
    if (Object.keys(anchors).length) w.fm.anchors = anchors;
  }

  for (const w of work.values()) {
    if (!w.dirty) continue;
    fs.mkdirSync(path.dirname(w.file), { recursive: true });
    const text = serialize(w.fm, w.body);
    if (!fs.existsSync(w.file) || fs.readFileSync(w.file, "utf8") !== text) fs.writeFileSync(w.file, text);
  }

  for (const [ref, t] of totals) if (needsDocling(t.dropped, t.total)) res.doclingFlags.push({ ref, ...t });

  const live = loadRulesDir(rulesDir, `kb:${kb}`).rules;
  writeIndex(kbRoot, compileIndex(kb, live, opts.now?.()));
  appendAudit(events, opts.audit);
  return res;
}
