// packages/core/src/knowledge/scores.ts — scores computed by code from the audit log, no LLM (KB spec §7, #901).
// Also owns audit compaction: months older than the 30-day scoring window fold into per-item stats files.
// verdicts.jsonl lives in the KB repo and is never touched here.
import fs from "node:fs";
import path from "node:path";
import { defaultAuditDir } from "./audit.js";
import type { AuditRecord } from "./fullpass.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const SCORE_WINDOW_DAYS = 30;

const WRITE_EVENTS = new Set(["item.proposed", "item.approved", "item.rejected", "item.applied", "item.promoted", "item.superseded", "item.archived"]);
const READ_EVENTS = new Set(["item.surfaced", "item.shown", "item.searched"]);
const OUTCOMES = new Set(["followed", "violated", "noise", "wrong"]);

export interface ItemCounts {
  surfaced: number; suppressed: number; searched: number; shown: number; cited: number;
  followed: number; violated: number; noise: number; wrong: number;
  chars: number; lastSurfaced?: string; lastUsed?: string;
}
const zero = (): ItemCounts => ({ surfaced: 0, suppressed: 0, searched: 0, shown: 0, cited: 0, followed: 0, violated: 0, noise: 0, wrong: 0, chars: 0 });
const later = (a: string | undefined, b: string | undefined) => (a && b ? (a > b ? a : b) : a ?? b);

export interface Tally {
  items: Record<string, ItemCounts & { domain: string; itemId: string }>;
  domains: Record<string, { writes: number; reads: number }>;
  agents: Record<string, number>;
  tiers: Record<string, number>;
}
const emptyTally = (): Tally => ({ items: {}, domains: {}, agents: {}, tiers: {} });

/** Fold audit records into counts. Events without an itemId (searches) still count toward domain reads. */
export function tally(records: AuditRecord[], into: Tally = emptyTally()): Tally {
  for (const e of records) {
    const domain = typeof e.domain === "string" && e.domain ? e.domain : "rules";
    const d = (into.domains[domain] ??= { writes: 0, reads: 0 });
    if (WRITE_EVENTS.has(e.event ?? "")) d.writes++;
    if (READ_EVENTS.has(e.event ?? "")) d.reads++;
    if (!e.itemId) continue;
    const c = (into.items[`${domain}|${e.itemId}`] ??= { ...zero(), domain, itemId: e.itemId });
    switch (e.event) {
      case "item.surfaced": {
        c.surfaced++; c.chars += Number(e.chars) || 0; c.lastSurfaced = later(c.lastSurfaced, e.ts);
        const agent = typeof e.agent === "string" ? e.agent : "unknown";
        into.agents[agent] = (into.agents[agent] ?? 0) + 1;
        const tier = typeof e.tier === "string" ? e.tier : typeof e.trigger === "string" ? e.trigger : "unknown";
        into.tiers[tier] = (into.tiers[tier] ?? 0) + 1;
        break;
      }
      case "item.suppressed": c.suppressed++; break;
      case "item.searched": c.searched++; break;
      case "item.shown": c.shown++; break;
      case "item.cited": c.cited++; c.lastUsed = later(c.lastUsed, e.ts); break;
      case "item.outcome": if (OUTCOMES.has(String(e.outcome))) c[e.outcome as "followed"]++; break;
    }
  }
  return into;
}

// ── compaction ───────────────────────────────────────────────────────

export interface CompactedMonth { month: string; machine: string; kbs: Record<string, Tally> }
const MONTH_FILE_RE = /^(\d{4}-\d{2})\.(.+)\.jsonl$/;
const statsFileName = (month: string, machine: string) => `${month}.${machine}.stats.json`;

function parseLines(file: string): AuditRecord[] {
  const out: AuditRecord[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as AuditRecord); } catch { /* skip */ }
  }
  return out;
}

/** Fold monthly logs that end before the scoring window into `<month>.<machine>.stats.json`, then drop the raw file. Returns the months compacted. */
export function compactAudit(o: { now: Date; dir?: string }): string[] {
  const dir = o.dir ?? defaultAuditDir();
  if (!fs.existsSync(dir)) return [];
  const cutoffMonth = new Date(o.now.getTime() - SCORE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 7);
  const done: string[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    const m = MONTH_FILE_RE.exec(f);
    if (!m || m[1] >= cutoffMonth) continue;
    const [, month, machine] = m;
    const byKb = new Map<string, AuditRecord[]>();
    for (const r of parseLines(path.join(dir, f))) byKb.set(r.kb ?? "", [...(byKb.get(r.kb ?? "") ?? []), r]);
    const statsPath = path.join(dir, statsFileName(month, machine));
    const prior: CompactedMonth | null = fs.existsSync(statsPath) ? JSON.parse(fs.readFileSync(statsPath, "utf8")) : null;
    const kbs: Record<string, Tally> = prior?.kbs ?? {};
    for (const [kb, recs] of byKb) kbs[kb] = tally(recs, kbs[kb]);
    fs.writeFileSync(`${statsPath}.tmp`, JSON.stringify({ month, machine, kbs } satisfies CompactedMonth));
    fs.renameSync(`${statsPath}.tmp`, statsPath);
    fs.unlinkSync(path.join(dir, f));
    done.push(month);
  }
  return done;
}

function readCompacted(kb: string, dir: string): Tally {
  const t = emptyTally();
  if (!fs.existsSync(dir)) return t;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".stats.json"))) {
    try {
      const k = (JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as CompactedMonth).kbs[kb];
      if (k) mergeTally(t, k);
    } catch { /* skip */ }
  }
  return t;
}
function mergeTally(into: Tally, from: Tally): void {
  for (const [k, c] of Object.entries(from.items)) {
    const t = (into.items[k] ??= { ...zero(), domain: c.domain, itemId: c.itemId });
    t.lastSurfaced = later(t.lastSurfaced, c.lastSurfaced);
    t.lastUsed = later(t.lastUsed, c.lastUsed);
    for (const f of Object.keys(zero()) as (keyof ItemCounts)[]) if (typeof c[f] === "number") (t[f] as number) += c[f] as number;
  }
  for (const [k, v] of Object.entries(from.domains)) { const d = (into.domains[k] ??= { writes: 0, reads: 0 }); d.writes += v.writes; d.reads += v.reads; }
  for (const [k, v] of Object.entries(from.agents)) into.agents[k] = (into.agents[k] ?? 0) + v;
  for (const [k, v] of Object.entries(from.tiers)) into.tiers[k] = (into.tiers[k] ?? 0) + v;
}

// ── scores ───────────────────────────────────────────────────────────

const ratio = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);

export interface ItemScore {
  domain: string; itemId: string;
  /** Last-30-day counts. */
  surfaced: number; suppressed: number; searched: number; shown: number; cited: number;
  followed: number; violated: number; noise: number; wrong: number;
  fireRate: number; pullRate: number;
  useRate: number | null; noiseRate: number | null; violationRate: number | null;
  lastSurfaced?: string; lastUsed?: string;
  neverFired30d: boolean;
  lifetimeSurfaced: number;
}
export interface DomainScore {
  domain: string; writesPerMonth: number; readsPerMonth: number; deadDomain: boolean;
  charsPerCitation: number | null; surfaced: number; cited: number;
}
export interface Scores {
  kb: string; generatedAt: string; windowDays: number;
  items: ItemScore[]; domains: DomainScore[];
  perAgentCoverage: Record<string, number>;
  tierContribution: Record<string, number>;
  reviewerAgreement: { resolved: number; approved: number; rate: number | null };
}

export interface ScoreInput {
  kb: string; records: AuditRecord[]; now: Date;
  /** Known items (active rules): lets never-fired be computed for items with no events at all. */
  known?: { id: string; domain: string; status: string }[];
  /** Pre-window totals from compacted months. */
  compacted?: Tally;
  verdicts?: Record<string, unknown>[];
}

/** Pure: same records and clock → same scores. */
export function computeScores(i: ScoreInput): Scores {
  const since = i.now.getTime() - SCORE_WINDOW_DAYS * DAY_MS;
  const win = tally(i.records.filter((r) => Date.parse(r.ts) >= since));
  const life = tally(i.records, i.compacted ? structuredClone(i.compacted) : undefined);
  const knownActive = new Set((i.known ?? []).filter((k) => k.status === "active").map((k) => `${k.domain}|${k.id}`));
  const keys = new Set([...Object.keys(win.items), ...Object.keys(life.items), ...knownActive]);
  const items: ItemScore[] = [...keys].sort().map((key) => {
    const [domain, itemId] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
    const w = win.items[key] ?? { ...zero(), domain, itemId };
    const l = life.items[key];
    return {
      domain, itemId, surfaced: w.surfaced, suppressed: w.suppressed, searched: w.searched, shown: w.shown, cited: w.cited,
      followed: w.followed, violated: w.violated, noise: w.noise, wrong: w.wrong,
      fireRate: w.surfaced, pullRate: w.shown,
      useRate: ratio(w.cited, w.surfaced), noiseRate: ratio(w.noise, w.surfaced), violationRate: ratio(w.violated, w.surfaced),
      lastSurfaced: l?.lastSurfaced, lastUsed: l?.lastUsed,
      neverFired30d: w.surfaced === 0 && (knownActive.has(key) || (l?.surfaced ?? 0) > 0), lifetimeSurfaced: l?.surfaced ?? 0,
    };
  });
  const domainNames = new Set([...Object.keys(win.domains), ...items.map((x) => x.domain)]);
  const domains: DomainScore[] = [...domainNames].sort().map((domain) => {
    const d = win.domains[domain] ?? { writes: 0, reads: 0 };
    const rows = items.filter((x) => x.domain === domain);
    const chars = Object.values(win.items).filter((x) => x.domain === domain).reduce((a, x) => a + x.chars, 0);
    const cited = rows.reduce((a, x) => a + x.cited, 0);
    return {
      domain, writesPerMonth: d.writes, readsPerMonth: d.reads, deadDomain: d.writes === 0 && d.reads === 0,
      charsPerCitation: cited ? Math.round(chars / cited) : null, surfaced: rows.reduce((a, x) => a + x.surfaced, 0), cited,
    };
  });
  const operator = (i.verdicts ?? []).filter((v) => v.kind === "operator");
  const approved = operator.filter((v) => (v.resolution as { kind?: string } | undefined)?.kind === "approve").length;
  return {
    kb: i.kb, generatedAt: i.now.toISOString(), windowDays: SCORE_WINDOW_DAYS, items, domains,
    perAgentCoverage: win.agents, tierContribution: win.tiers,
    reviewerAgreement: { resolved: operator.length, approved, rate: ratio(approved, operator.length) },
  };
}

/** Read everything for one KB (raw logs + compacted months + verdicts) and score it. */
export function scoreKb(o: { kb: string; now: Date; auditDir?: string; kbRoot: string; known?: ScoreInput["known"] }): Scores {
  const dir = o.auditDir ?? defaultAuditDir();
  const records: AuditRecord[] = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((n) => MONTH_FILE_RE.test(n)).sort()) {
      records.push(...parseLines(path.join(dir, f)).filter((r) => r.kb === o.kb));
    }
  }
  let verdicts: Record<string, unknown>[] = [];
  try { verdicts = fs.readFileSync(path.join(o.kbRoot, "verdicts.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none yet */ }
  return computeScores({ kb: o.kb, records, now: o.now, known: o.known, compacted: readCompacted(o.kb, dir), verdicts });
}

export const scoresFile = (kbRoot: string) => path.join(kbRoot, "scores.json");
export function writeScores(kbRoot: string, s: Scores): void {
  fs.mkdirSync(kbRoot, { recursive: true });
  fs.writeFileSync(scoresFile(kbRoot), JSON.stringify(s, null, 2) + "\n");
}

/** REPORT.md section. Counts and ids only: no prompt text. */
export function renderScoresSection(s: Scores): string[] {
  const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
  const used = s.items.filter((x) => x.surfaced).sort((a, b) => b.surfaced - a.surfaced || a.itemId.localeCompare(b.itemId)).slice(0, 10);
  const never = s.items.filter((x) => x.neverFired30d).map((x) => x.itemId);
  return [
    "", `## Scores (${s.windowDays} days)`, "",
    ...(used.length ? ["| Item | Surfaced | Pulled | Cited | Use | Noise | Violated |", "|---|---|---|---|---|---|---|",
      ...used.map((x) => `| ${x.itemId} | ${x.surfaced} | ${x.shown} | ${x.cited} | ${pct(x.useRate)} | ${pct(x.noiseRate)} | ${pct(x.violationRate)} |`)] : ["No items surfaced."]),
    "", `- Never fired (${never.length}): ${never.slice(0, 20).join(", ") || "none"}${never.length > 20 ? ", …" : ""}`,
    `- Tier contribution: ${Object.entries(s.tierContribution).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
    `- Per-agent coverage (surfaced): ${Object.entries(s.perAgentCoverage).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
    `- Reviewer agreement: ${pct(s.reviewerAgreement.rate)} (${s.reviewerAgreement.approved}/${s.reviewerAgreement.resolved} operator resolutions approved)`,
    "", "| Domain | Writes/mo | Reads/mo | Chars per citation | Alarm |", "|---|---|---|---|---|",
    ...s.domains.map((d) => `| ${d.domain} | ${d.writesPerMonth} | ${d.readsPerMonth} | ${d.charsPerCitation ?? "n/a"} | ${d.deadDomain ? "DEAD (no activity 30d)" : ""} |`),
  ];
}
