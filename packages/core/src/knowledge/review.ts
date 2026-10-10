// packages/core/src/knowledge/review.ts — reviewer decisions, escalations, code-vs-doc (rules spec §5, #898).
// The reviewer (a crew running the `knowledge-review` skill) emits typed decisions; code decides what may
// auto-apply. The always-escalate rules are enforced here, never left to the reviewer's confidence.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  type KnowledgeSourceEntry, type Rule, type RuleAnchors, type RuleDecision, type RuleDecisionVerdict,
  type RuleFrontmatter, type RuleModality, type SquadrantConfig,
} from "@squadrant/shared";
import { appendAudit, type AuditEvent, type AuditSink } from "./audit.js";
import { computeAnchor } from "./anchor.js";
import { compileIndex, writeIndex } from "./index-file.js";
import { expandSource, fileForRef, refFor } from "./ingest.js";
import { kbDir, kbRulesDir, PROPOSED_DIR } from "./paths.js";
import { reconcileConfig } from "./schedule.js";
import { loadRulesDir } from "./store.js";

export type Priority = "company" | "project" | "agent";
const PRIORITY_RANK: Record<Priority, number> = { company: 3, project: 2, agent: 1 };
const SHA_LEN = 12;
const strong = (m: RuleModality) => m === "must" || m === "must-not";

// ---------- typed decisions ----------

export interface CodeConflict {
  /** Project whose repo holds the contradicting code. */
  project: string;
  /** Files (repo-relative) the reviewer found contradicting the rule. */
  files: string[];
  summary: string;
}
export interface ReviewDecision {
  /** `_proposed` key `<id>@<sha12>`, or `stale:<ruleId>` for a stale-rule decision, or a live rule id when only `codeConflict` is reported. */
  item: string;
  decision: "approve" | "reject" | "escalate" | `merge-into:${string}`;
  confidence: number;
  justification: string;
  /** Reviewer asks for a human regardless of confidence. */
  flag?: boolean;
  codeConflict?: CodeConflict;
  /** stale: the source still supports the rule here, so just update `loc`. */
  loc?: string;
}
export interface PairDecision {
  a: string;
  b: string;
  relation: "duplicate" | "refines" | "conflicts" | "unrelated";
  confidence: number;
  justification: string;
  /** duplicate: the id to keep. */
  keep?: string;
}
export interface DecisionFile { decisions?: ReviewDecision[]; pairs?: PairDecision[] }

export interface Escalation {
  key: string;
  kind: "proposal" | "stale-retire" | "pair" | "code-vs-doc" | "code-violation" | "domain-cap" | "override-base-changed" | "usage";
  ruleId?: string;
  item?: string;
  reasons: string[];
  explanation: string;
  confidence?: number;
  createdAt: string;
  /** false = informational (REPORT only), not counted as "needs you". */
  needsYou: boolean;
  /** code-vs-doc: what the operator's answer will be recorded against. */
  evidence?: { docRev: string; codeRev: string; files: string[]; project: string };
}
export const escalationsFile = (kbRoot: string) => path.join(kbRoot, "escalations.json");
export const verdictsFile = (kbRoot: string) => path.join(kbRoot, "verdicts.jsonl");

export function readEscalations(kbRoot: string): Escalation[] {
  try { return (JSON.parse(fs.readFileSync(escalationsFile(kbRoot), "utf8")) as { items: Escalation[] }).items; } catch { return []; }
}
export function writeEscalations(kbRoot: string, items: Escalation[]): void {
  fs.mkdirSync(kbRoot, { recursive: true });
  fs.writeFileSync(escalationsFile(kbRoot), JSON.stringify({ items }, null, 2) + "\n");
}
/** Add an escalation unless one with the same key is already open. */
export function addEscalation(kbRoot: string, e: Escalation): boolean {
  const items = readEscalations(kbRoot);
  if (items.some((x) => x.key === e.key)) return false;
  writeEscalations(kbRoot, [...items, e]);
  return true;
}
export const needsYouCount = (kbRoot: string) => readEscalations(kbRoot).filter((e) => e.needsYou).length;

/** Verdicts are the future eval set: append-only, never compacted. */
export function appendVerdict(kbRoot: string, v: Record<string, unknown>, now: Date): void {
  fs.mkdirSync(kbRoot, { recursive: true });
  fs.appendFileSync(verdictsFile(kbRoot), JSON.stringify({ ts: now.toISOString(), ...v }) + "\n");
}

// ---------- git / source-date seam ----------

export interface RevInfo { rev: string; date: string }
export interface GitSeam {
  /** Last commit touching any of `files` under `root`. null = no history / not a repo. */
  lastCommit(root: string, files: string[]): RevInfo | null;
  /** Did any commit touch `files` after `sinceIso`? */
  changedSince(root: string, files: string[], sinceIso: string): boolean;
  /** Date a source doc was last revised (git commit date, else mtime). */
  docDate(file: string): string | null;
}
const git = (root: string, args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
export const realGit: GitSeam = {
  lastCommit(root, files) {
    try { const [rev, date] = git(root, ["log", "-1", "--format=%H%x09%cI", "--", ...files]).split("\t"); return rev && date ? { rev, date } : null; } catch { return null; }
  },
  changedSince(root, files, since) {
    try { return git(root, ["log", "--since", since, "--format=%H", "--", ...files]) !== ""; } catch { return false; }
  },
  docDate(file) {
    try {
      const d = git(path.dirname(file), ["log", "-1", "--format=%cI", "--", path.basename(file)]);
      if (d) return d;
    } catch { /* not a repo */ }
    try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
  },
};

// ---------- context ----------

export interface ReviewContext {
  cfg: SquadrantConfig;
  kb: string;
  sources: KnowledgeSourceEntry[];
  audit?: AuditSink;
  now?: () => Date;
  git?: GitSeam;
  /** project → repo root, for code-vs-doc and anchoring. */
  projects?: { name: string; root: string }[];
}
const nowOf = (c: ReviewContext) => c.now?.() ?? new Date();

/** priority of a source ref: `agent:` refs are agent; otherwise the sources.yaml entry that lists the file. */
export function priorityOfRef(c: ReviewContext, ref: string): Priority {
  if (ref.startsWith("agent:")) return "agent";
  const root = kbDir(c.cfg, c.kb);
  for (const e of c.sources) for (const f of expandSource(root, e)) if (refFor(root, f) === ref) return e.priority;
  return "project";
}
export function priorityOfRule(c: ReviewContext, r: Pick<Rule, "sources">): Priority {
  return r.sources.map((s) => priorityOfRef(c, s.ref)).sort((a, b) => PRIORITY_RANK[b] - PRIORITY_RANK[a])[0] ?? "project";
}

// ---------- proposals ----------

export interface Proposal { key: string; rule: Rule; live?: Rule }

export function loadProposals(c: ReviewContext): { proposals: Proposal[]; live: Rule[] } {
  const dir = kbRulesDir(c.cfg, c.kb);
  const live = loadRulesDir(dir, `kb:${c.kb}`).rules;
  const byId = new Map(live.map((r) => [r.id, r]));
  const proposals: Proposal[] = [];
  const pdirs = new Set<string>();
  for (const f of fs.existsSync(dir) ? walkDirs(dir) : []) if (path.basename(f) === PROPOSED_DIR) pdirs.add(f);
  for (const pd of pdirs) {
    for (const rule of loadRulesDir(pd, `kb:${c.kb}`, { includeProposed: true }).rules) {
      proposals.push({ key: path.basename(rule.file).replace(/\.md$/, ""), rule, live: byId.get(rule.id) });
    }
  }
  return { proposals, live };
}
function walkDirs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) { const f = path.join(dir, e.name); out.push(f); walkDirs(f, out); }
  return out;
}

const fileText = (fm: RuleFrontmatter, body: string) => matter.stringify(body.trim() + "\n", JSON.parse(JSON.stringify(fm)) as object);
const readFm = (file: string) => { const m = matter(fs.readFileSync(file, "utf8")); return { fm: m.data as RuleFrontmatter & Record<string, unknown>, body: m.content }; };

function reindex(c: ReviewContext): void {
  const live = loadRulesDir(kbRulesDir(c.cfg, c.kb), `kb:${c.kb}`).rules;
  writeIndex(kbDir(c.cfg, c.kb), compileIndex(c.kb, live, nowOf(c)));
}

function anchorsFor(c: ReviewContext, fm: RuleFrontmatter): RuleAnchors | undefined {
  const anchors: RuleAnchors = { ...(fm.anchors ?? {}) };
  for (const p of c.projects ?? []) { const a = computeAnchor(p.root, fm.triggers); if (a) anchors[p.name] = a; }
  return Object.keys(anchors).length ? anchors : undefined;
}

export interface ApplyEvents { events: AuditEvent[] }
const ev = (c: ReviewContext, event: AuditEvent["event"], itemId: string, domain: string, extra: Partial<AuditEvent> = {}): AuditEvent =>
  ({ kb: c.kb, level: "group", project: "", domain, itemId, event, ...extra });

/** Make a proposal live: replaces its live counterpart, retires the rules it conflicts with. */
export function promoteProposal(c: ReviewContext, p: Proposal, by: "reviewer-agent" | "human", justification: string, events: AuditEvent[]): void {
  const dir = kbRulesDir(c.cfg, c.kb);
  const { fm, body } = readFm(p.rule.file);
  const retired: string[] = [];
  for (const id of fm.conflictsWith ?? []) {
    const other = loadRulesDir(dir, `kb:${c.kb}`).rules.find((r) => r.id === id);
    if (!other || other.id === fm.id) continue;
    const o = readFm(other.file);
    o.fm.status = "retired";
    fs.writeFileSync(other.file, fileText(o.fm, o.body));
    retired.push(id);
    events.push(ev(c, "item.superseded", id, o.fm.domain));
  }
  const next: RuleFrontmatter = { ...fm, status: "active", approvedBy: by, justification, supersedes: [...new Set([...(fm.supersedes ?? []), ...retired])], conflictsWith: [] };
  if (p.live?.decision) next.decision = p.live.decision;
  const anchors = anchorsFor(c, { ...next, anchors: p.live?.anchors ?? fm.anchors });
  if (anchors) next.anchors = anchors;
  const target = p.live?.file ?? path.join(dir, next.domain, `${next.id}.md`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fileText(next, body));
  fs.rmSync(p.rule.file);
  events.push(ev(c, "item.approved", next.id, next.domain), ev(c, "item.applied", next.id, next.domain));
  if (p.live) events.push(ev(c, "item.superseded", next.id, next.domain));
}

function dropProposal(c: ReviewContext, p: Proposal, events: AuditEvent[]): void {
  fs.rmSync(p.rule.file);
  events.push(ev(c, "item.rejected", p.rule.id, p.rule.domain, { reason: "reviewer" }));
}

function mergeInto(c: ReviewContext, p: Proposal, targetId: string, live: Rule[], events: AuditEvent[]): boolean {
  const t = live.find((r) => r.id === targetId);
  if (!t) return false;
  const tf = readFm(t.file);
  for (const s of p.rule.sources) if (!tf.fm.sources.some((x) => x.ref === s.ref)) tf.fm.sources.push(s);
  fs.writeFileSync(t.file, fileText(tf.fm, tf.body));
  fs.rmSync(p.rule.file);
  events.push(ev(c, "item.superseded", p.rule.id, p.rule.domain), ev(c, "item.applied", targetId, t.domain));
  return true;
}

// ---------- code vs doc ----------

export type CodeDocVerdict =
  | { action: "escalate"; explanation: string; evidence: NonNullable<Escalation["evidence"]> }
  | { action: "skip-decided" }
  | { action: "flag-violation"; explanation: string };

const docRevOf = (r: Pick<Rule, "sources">) => r.sources.map((s) => `${s.ref}@${s.sha.slice(0, SHA_LEN)}`).join(",");

/** Operator decision 2026-10-09: code newer than the doc is never auto-superseded; a recorded decision is not re-asked. */
export function evaluateCodeConflict(c: ReviewContext, rule: Rule, cc: CodeConflict): CodeDocVerdict {
  const g = c.git ?? realGit;
  const proj = (c.projects ?? []).find((p) => p.name === cc.project);
  const root = proj?.root;
  const code = root ? g.lastCommit(root, cc.files) : null;
  const kbRoot = kbDir(c.cfg, c.kb);
  const docDates = rule.sources.map((s) => g.docDate(fileForRef(kbRoot, s.ref))).filter((d): d is string => !!d).sort();
  const docDate = docDates[docDates.length - 1];
  const docRev = docRevOf(rule);
  const evidence = { docRev, codeRev: code?.rev ?? "unknown", files: cc.files, project: cc.project };
  const doc = rule.sources.map((s) => `${s.ref} (${docDate ?? "date unknown"})`).join(", ");
  if (!code || !docDate) {
    return { action: "escalate", evidence, explanation: `Rule ${rule.id} ("${rule.statement}") may conflict with code in ${cc.project} (${cc.files.join(", ")}): ${cc.summary}. Dates could not be verified (doc ${doc}; code ${code?.date ?? "unknown"}), so a human must judge it.` };
  }
  if (Date.parse(docDate) >= Date.parse(code.date)) {
    return { action: "flag-violation", explanation: `Code in ${cc.project} (${cc.files.join(", ")}, last commit ${code.date}) contradicts rule ${rule.id}, but the doc (${doc}) is newer: treat the code as the violation. ${cc.summary}` };
  }
  const d = rule.decision;
  if (d && d.docRev === docRev && !g.changedSince(root!, cc.files, d.at)) return { action: "skip-decided" };
  const reopened = d ? ` An earlier decision (${d.verdict}, ${d.at}) is re-opened because ${d.docRev !== docRev ? "the doc has a new revision" : "the anchored code changed after it"}.` : "";
  return {
    action: "escalate", evidence,
    explanation: `Rule ${rule.id} ("${rule.statement}") from ${doc} is contradicted by newer code: ${cc.project} ${cc.files.join(", ")} (last commit ${code.date}). ${cc.summary}`
      + ` Keeping the doc leaves the code in violation; superseding with the code retires this rule and any code-derived replacement inherits its priority unless you say otherwise.${reopened}`,
  };
}

// ---------- applying a decision file ----------

export interface ReviewResult {
  applied: string[];
  escalated: { key: string; reasons: string[] }[];
  violations: string[];
  skipped: { item: string; reason: string }[];
}

export function applyDecisions(file: DecisionFile, c: ReviewContext): ReviewResult {
  const now = nowOf(c);
  const kbRoot = kbDir(c.cfg, c.kb);
  const threshold = reconcileConfig(c.cfg, c.kb).autoApproveConfidence;
  const res: ReviewResult = { applied: [], escalated: [], violations: [], skipped: [] };
  const events: AuditEvent[] = [];
  let { proposals, live } = loadProposals(c);

  const escalate = (e: Omit<Escalation, "createdAt" | "needsYou"> & { needsYou?: boolean }) => {
    addEscalation(kbRoot, { createdAt: now.toISOString(), needsYou: true, ...e });
    res.escalated.push({ key: e.key, reasons: e.reasons });
  };
  const verdict = (d: { item: string }, outcome: string, extra: Record<string, unknown> = {}) =>
    appendVerdict(kbRoot, { kb: c.kb, kind: "review", item: d.item, outcome, ...extra }, now);

  for (const d of file.decisions ?? []) {
    const conf = Number.isFinite(d.confidence) ? d.confidence : 0;
    const stale = d.item.startsWith("stale:");
    const prop = stale ? undefined : proposals.find((p) => p.key === d.item);
    const rule = stale ? live.find((r) => r.id === d.item.slice(6)) : prop?.rule ?? live.find((r) => r.id === d.item);
    if (!rule) { res.skipped.push({ item: d.item, reason: "no such proposal or rule" }); continue; }
    const reasons: string[] = [];

    if (d.codeConflict) {
      const target = prop?.live ?? live.find((r) => r.id === rule.id) ?? rule;
      const v = evaluateCodeConflict(c, target, d.codeConflict);
      if (v.action === "flag-violation") {
        escalate({ key: `violation:${target.id}`, kind: "code-violation", ruleId: target.id, reasons: ["doc newer than code"], explanation: v.explanation, needsYou: false });
        res.violations.push(target.id);
      } else if (v.action === "escalate") {
        escalate({ key: `code-vs-doc:${target.id}`, kind: "code-vs-doc", ruleId: target.id, reasons: ["code-vs-doc"], explanation: v.explanation, evidence: v.evidence, confidence: conf });
        verdict(d, "escalated", { reasons: ["code-vs-doc"], confidence: conf });
      }
      if (!prop && !stale) continue; // a pure code-conflict report has nothing else to apply
      if (v.action === "escalate") { reasons.push("code-vs-doc"); }
    }

    if (stale) {
      if (d.decision === "reject") {
        const f = readFm(rule.file);
        f.fm.status = "active";
        if (d.loc && f.fm.sources[0]) f.fm.sources[0].loc = d.loc;
        if (conf >= threshold && !d.flag && !reasons.length) { fs.writeFileSync(rule.file, fileText(f.fm, f.body)); res.applied.push(d.item); events.push(ev(c, "item.applied", rule.id, rule.domain)); verdict(d, "applied", { confidence: conf }); continue; }
        reasons.push(conf < threshold ? "low-confidence" : "reviewer-flagged");
      } else if (d.decision === "approve") {
        if (strong(rule.modality)) reasons.push("retiring must/must-not");
        if (conf < threshold) reasons.push("low-confidence");
        if (d.flag) reasons.push("reviewer-flagged");
        if (!reasons.length) {
          const f = readFm(rule.file);
          f.fm.status = "retired";
          fs.writeFileSync(rule.file, fileText(f.fm, f.body));
          res.applied.push(d.item); events.push(ev(c, "item.archived", rule.id, rule.domain)); verdict(d, "applied", { confidence: conf });
          continue;
        }
      } else reasons.push("reviewer-flagged");
      escalate({ key: d.item, kind: "stale-retire", ruleId: rule.id, item: d.item, reasons: [...new Set(reasons)], explanation: `Rule ${rule.id} ("${rule.statement}") lost its source support. Reviewer: ${d.justification}`, confidence: conf });
      verdict(d, "escalated", { reasons, confidence: conf });
      continue;
    }

    const p = prop!;
    if (d.decision === "escalate" || d.flag) reasons.push("reviewer-flagged");
    if (conf < threshold) reasons.push("low-confidence");
    if (d.decision === "approve") {
      const myPri = priorityOfRule(c, p.rule);
      const conflicted = (p.rule.conflictsWith ?? []).map((id) => live.find((r) => r.id === id)).filter((r): r is Rule => !!r);
      if (myPri === "company" && conflicted.some((r) => priorityOfRule(c, r) === "company")) reasons.push("company-vs-company conflict");
      const retired = [...conflicted, ...(p.live && p.live.modality !== p.rule.modality ? [p.live] : [])];
      if (retired.some((r) => strong(r.modality))) reasons.push("retiring must/must-not");
    }
    if (reasons.length) {
      escalate({ key: p.key, kind: "proposal", ruleId: p.rule.id, item: p.key, reasons: [...new Set(reasons)], explanation: `Proposal ${p.key}: "${p.rule.statement}"${p.live ? ` (replaces live "${p.live.statement}")` : ""}. Reviewer (${d.decision}, ${conf}): ${d.justification}`, confidence: conf });
      verdict(d, "escalated", { reasons: [...new Set(reasons)], confidence: conf, decision: d.decision });
      continue;
    }
    if (d.decision === "approve") promoteProposal(c, p, "reviewer-agent", d.justification, events);
    else if (d.decision === "reject") dropProposal(c, p, events);
    else if (d.decision.startsWith("merge-into:")) {
      if (!mergeInto(c, p, d.decision.slice("merge-into:".length), live, events)) { res.skipped.push({ item: d.item, reason: `merge target ${d.decision.slice(11)} not found` }); continue; }
    } else { res.skipped.push({ item: d.item, reason: `unknown decision '${d.decision}'` }); continue; }
    res.applied.push(d.item);
    verdict(d, "applied", { decision: d.decision, confidence: conf, justification: d.justification });
    ({ proposals, live } = loadProposals(c));
  }

  for (const pd of file.pairs ?? []) applyPair(pd, c, res, threshold, events, kbRoot, now);

  reindex(c);
  appendAudit(events, c.audit);
  return res;
}

function applyPair(pd: PairDecision, c: ReviewContext, res: ReviewResult, threshold: number, events: AuditEvent[], kbRoot: string, now: Date): void {
  const { live } = loadProposals(c);
  const a = live.find((r) => r.id === pd.a), b = live.find((r) => r.id === pd.b);
  const key = `pair:${[pd.a, pd.b].sort().join("+")}`;
  if (!a || !b) { res.skipped.push({ item: key, reason: "rule not found" }); return; }
  const esc = (reasons: string[]) => {
    addEscalation(kbRoot, { key, kind: "pair", reasons, explanation: `${a.id} ("${a.statement}") vs ${b.id} ("${b.statement}"): ${pd.relation}. ${pd.justification}`, confidence: pd.confidence, createdAt: now.toISOString(), needsYou: true });
    res.escalated.push({ key, reasons });
  };
  appendVerdict(kbRoot, { kb: c.kb, kind: "pair", item: key, relation: pd.relation, confidence: pd.confidence }, now);
  if (pd.relation === "unrelated" || pd.relation === "refines") return;
  if (pd.relation === "conflicts") {
    const reasons = priorityOfRule(c, a) === "company" && priorityOfRule(c, b) === "company" ? ["company-vs-company conflict"] : pd.confidence < threshold ? ["low-confidence"] : [];
    if (reasons.length) { esc(reasons); return; }
    // Different priorities: record the conflict on both; the higher-priority rule wins at delivery.
    for (const [x, y] of [[a, b], [b, a]] as const) { const f = readFm(x.file); f.fm.conflictsWith = [...new Set([...(f.fm.conflictsWith ?? []), y.id])]; fs.writeFileSync(x.file, fileText(f.fm, f.body)); }
    return;
  }
  const keep = pd.keep === b.id ? b : a, drop = keep === a ? b : a;
  const reasons = [...(pd.confidence < threshold ? ["low-confidence"] : []), ...(strong(drop.modality) && drop.modality !== keep.modality ? ["retiring must/must-not"] : [])];
  if (reasons.length) { esc(reasons); return; }
  const kf = readFm(keep.file);
  for (const s of drop.sources) if (!kf.fm.sources.some((x) => x.ref === s.ref)) kf.fm.sources.push(s);
  kf.fm.supersedes = [...new Set([...(kf.fm.supersedes ?? []), drop.id])];
  fs.writeFileSync(keep.file, fileText(kf.fm, kf.body));
  const df = readFm(drop.file);
  df.fm.status = "retired";
  fs.writeFileSync(drop.file, fileText(df.fm, df.body));
  events.push(ev(c, "item.superseded", drop.id, drop.domain), ev(c, "item.applied", keep.id, keep.domain));
  res.applied.push(key);
}

// ---------- operator resolution ----------

export type Resolution =
  | { kind: "approve" } | { kind: "reject" }
  | { kind: "verdict"; verdict: RuleDecisionVerdict };

/** Apply the operator's answer to one open escalation, then close it. */
export function resolveEscalation(c: ReviewContext, key: string, r: Resolution, by: string, reason: string): string {
  const now = nowOf(c);
  const kbRoot = kbDir(c.cfg, c.kb);
  const items = readEscalations(kbRoot);
  const esc = items.find((e) => e.key === key);
  if (!esc) throw new Error(`No open escalation '${key}'`);
  const events: AuditEvent[] = [];
  const { proposals, live } = loadProposals(c);
  const done = (msg: string) => {
    writeEscalations(kbRoot, items.filter((e) => e.key !== key));
    appendVerdict(kbRoot, { kb: c.kb, kind: "operator", item: key, resolution: r, by, reason }, now);
    reindex(c);
    appendAudit(events, c.audit);
    return msg;
  };

  if (esc.kind === "code-vs-doc") {
    if (r.kind !== "verdict") throw new Error("code-vs-doc needs --keep-doc or --supersede-with-code");
    const rule = live.find((x) => x.id === esc.ruleId);
    if (!rule || !esc.evidence) throw new Error(`rule ${esc.ruleId} or its evidence is gone`);
    const f = readFm(rule.file);
    const decision: RuleDecision = { by, at: now.toISOString(), verdict: r.verdict, docRev: esc.evidence.docRev, codeRev: esc.evidence.codeRev, files: esc.evidence.files, reason };
    f.fm.decision = decision;
    if (r.verdict === "supersede-with-code") { f.fm.status = "retired"; events.push(ev(c, "item.superseded", rule.id, rule.domain)); }
    fs.writeFileSync(rule.file, fileText(f.fm, f.body));
    return done(`${rule.id}: ${r.verdict}`);
  }
  if (esc.kind === "proposal") {
    const p = proposals.find((x) => x.key === esc.item);
    if (!p) throw new Error(`proposal ${esc.item} no longer exists`);
    if (r.kind === "approve") promoteProposal(c, p, "human", reason || "approved by operator", events);
    else if (r.kind === "reject") dropProposal(c, p, events);
    else throw new Error("proposal needs approve or reject");
    return done(`${p.key}: ${r.kind}`);
  }
  if (esc.kind === "stale-retire") {
    const rule = live.find((x) => x.id === esc.ruleId);
    if (rule) { const f = readFm(rule.file); f.fm.status = r.kind === "approve" ? "retired" : "active"; fs.writeFileSync(rule.file, fileText(f.fm, f.body)); events.push(ev(c, r.kind === "approve" ? "item.archived" : "item.applied", rule.id, rule.domain)); }
    return done(`${esc.ruleId}: ${r.kind === "approve" ? "retired" : "kept"}`);
  }
  if (esc.kind === "override-base-changed") {
    const ov = esc.item && fs.existsSync(esc.item) ? esc.item : undefined;
    if (ov) {
      if (r.kind === "reject") fs.rmSync(ov); // drop the override: the KB rule applies again
      else { const f = readFm(ov); f.fm.overridesBase = esc.evidence?.docRev; fs.writeFileSync(ov, fileText(f.fm, f.body)); }
    }
    return done(`${esc.ruleId}: override ${r.kind === "reject" ? "dropped" : "kept"}`);
  }
  // pair / domain-cap / usage / code-violation: acknowledged here; the operator edits rules directly.
  return done(`${key}: acknowledged`);
}

// ---------- agent proposals ----------

export function proposeAgentRule(c: ReviewContext, o: { statement: string; evidence: string; id?: string; domain?: string; modality?: RuleModality; agent?: string }): string {
  const sha = crypto.createHash("sha256").update(`${o.statement}\n${o.evidence}`).digest("hex");
  const slug = o.statement.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 6).join("-") || "proposal";
  const id = o.id ?? `agent.${slug}`;
  const domain = o.domain ?? "general";
  const fm: RuleFrontmatter = {
    id, domain, modality: o.modality ?? "should", status: "proposed",
    sources: [{ ref: `agent:${o.agent ?? "unknown"}`, sha, quote: o.evidence.trim() }],
    approvedBy: "reviewer-agent", justification: "", supersedes: [], conflictsWith: [],
  };
  const dir = path.join(kbRulesDir(c.cfg, c.kb), PROPOSED_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}@${sha.slice(0, SHA_LEN)}.md`);
  fs.writeFileSync(file, fileText(fm, o.statement));
  appendAudit([ev(c, "item.proposed", id, domain)], c.audit);
  return file;
}

// ---------- review packet (input for the reviewer) ----------

export interface ReviewPacket {
  kb: string;
  autoApproveConfidence: number;
  proposals: { item: string; id: string; domain: string; modality: RuleModality; statement: string; priority: Priority; sources: Rule["sources"]; replaces?: { statement: string; modality: RuleModality }; conflictsWith: { id: string; statement: string; modality: RuleModality; priority: Priority }[] }[];
  stale: { item: string; id: string; modality: RuleModality; statement: string; sources: Rule["sources"] }[];
  decided: { id: string; verdict: RuleDecisionVerdict; at: string }[];
  open: Escalation[];
}

export function buildReviewPacket(c: ReviewContext): ReviewPacket {
  const { proposals, live } = loadProposals(c);
  return {
    kb: c.kb,
    autoApproveConfidence: reconcileConfig(c.cfg, c.kb).autoApproveConfidence,
    proposals: proposals.map((p) => ({
      item: p.key, id: p.rule.id, domain: p.rule.domain, modality: p.rule.modality, statement: p.rule.statement,
      priority: priorityOfRule(c, p.rule), sources: p.rule.sources,
      ...(p.live ? { replaces: { statement: p.live.statement, modality: p.live.modality } } : {}),
      conflictsWith: (p.rule.conflictsWith ?? []).flatMap((id) => { const r = live.find((x) => x.id === id); return r ? [{ id, statement: r.statement, modality: r.modality, priority: priorityOfRule(c, r) }] : []; }),
    })),
    stale: live.filter((r) => r.status === "stale").map((r) => ({ item: `stale:${r.id}`, id: r.id, modality: r.modality, statement: r.statement, sources: r.sources })),
    decided: live.filter((r) => r.decision).map((r) => ({ id: r.id, verdict: r.decision!.verdict, at: r.decision!.at })),
    open: readEscalations(kbDir(c.cfg, c.kb)),
  };
}
