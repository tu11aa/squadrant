import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import matter from "gray-matter";
import {
  applyCandidates, planIngest, loadRulesDir, findQuote, normalizeText, needsDocling, splitSections, computeAnchor,
  PROPOSED_DIR, type Candidate, type CandidateFile, type Converter,
} from "../knowledge/index.js";

const FIX = path.join(__dirname, "fixtures", "knowledge-golden");
const SOURCES = [{ path: "raw/**", priority: "company" as const }];
let kb: string;
let rulesDir: string;
let auditDir: string;

const preConverted = (dir: string): Converter => async (file) => fs.readFileSync(path.join(dir, `${path.basename(file)}.md`), "utf8");
const cands = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8")) as CandidateFile;
const apply = (f: CandidateFile, extra = {}) => applyCandidates(f, { kb: "t", kbRoot: kb, rulesDir, audit: { dir: auditDir, machineId: "m" }, ...extra });
const ingest = (convDir = path.join(FIX, "converted"), extra = {}) => planIngest(kb, { sources: SOURCES, converter: preConverted(convDir), ...extra });
const rules = () => loadRulesDir(rulesDir, "kb:t").rules;
const audit = () => fs.readdirSync(auditDir).flatMap((f) => fs.readFileSync(path.join(auditDir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));

beforeEach(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ingest-"));
  rulesDir = path.join(kb, "shared", "rules");
  auditDir = path.join(kb, "_audit");
  fs.cpSync(path.join(FIX, "raw"), path.join(kb, "raw"), { recursive: true });
});
afterEach(() => fs.rmSync(kb, { recursive: true, force: true }));

describe("verify", () => {
  it("finds verbatim and whitespace/hyphenation/smart-quote variants, with original offsets", () => {
    const src = "Intro.\nAll   VND amounts shall be\nrounded half-\nup — to the “unit”.\n";
    const span = findQuote(src, 'All VND amounts shall be rounded half-up - to the "unit".')!;
    expect(span).not.toBeNull();
    expect(src.slice(span[0], span[1])).toMatch(/^All {3}VND[\s\S]*“unit”\.$/);
    expect(findQuote(src, "ﬁnal")).toBeNull();
    expect(normalizeText("ﬁnal ofﬁce")).toBe("final office");
    expect(findQuote("not here", "absent quote")).toBeNull();
  });
  it("flags docling only above 20% dropped", () => {
    expect(needsDocling(1, 5)).toBe(false);
    expect(needsDocling(2, 5)).toBe(true);
    expect(needsDocling(0, 0)).toBe(false);
  });
  it("splits sections at headings", () => {
    const t = "# A\none\n\n## B\ntwo\n";
    expect(splitSections(t).map((s) => s.heading)).toEqual(["A", "B"]);
  });
});

describe("planIngest", () => {
  it("converts changed sources once; unchanged sources are skipped on re-run (mtime+size)", async () => {
    const p1 = await ingest();
    expect(p1.sources.map((s) => s.ref).sort()).toEqual(["raw/billing-policy.md", "raw/handbook.docx", "raw/security.pdf"]);
    expect(p1.sources.every((s) => fs.existsSync(s.converted))).toBe(true);
    const p2 = await ingest();
    expect(p2.sources).toEqual([]);
  });
  it("touching mtime without changing content re-hashes but stays clean", async () => {
    await ingest();
    const f = path.join(kb, "raw", "billing-policy.md");
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect((await ingest()).sources).toEqual([]);
  });
  it("--dry-run estimates tokens and writes nothing", async () => {
    const p = await ingest(path.join(FIX, "converted"), { dryRun: true });
    expect(p.estimatedTokens).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(kb, ".converted"))).toBe(false);
  });
  it("maxSectionsPerPass caps a pass and carries the rest to the next", async () => {
    const p1 = await ingest(undefined, { maxSectionsPerPass: 2 });
    expect(p1.sectionCount).toBe(2);
    expect(p1.carriedSections).toBeGreaterThan(0);
    let total = p1.sectionCount;
    for (let i = 0; i < 10; i++) { const p = await ingest(undefined, { maxSectionsPerPass: 2 }); total += p.sectionCount; if (!p.sectionCount) break; }
    expect(total).toBe(7);
    expect((await ingest(undefined, { maxSectionsPerPass: 2 })).sources).toEqual([]);
  });
  it("skips local-only sources without a local model, plans them with one", async () => {
    const src = [{ path: "raw/security.pdf", priority: "company" as const, sensitivity: "local-only" as const }];
    const a = await planIngest(kb, { sources: src, converter: preConverted(path.join(FIX, "converted")) });
    expect(a.sources).toEqual([]);
    expect(a.skipped[0].reason).toContain("local-only");
    const b = await planIngest(kb, { sources: src, localModel: true, converter: preConverted(path.join(FIX, "converted")) });
    expect(b.sources.map((s) => s.ref)).toEqual(["raw/security.pdf"]);
  });
  it("a failing conversion is reported and the run continues", async () => {
    const bad: Converter = async (f) => { if (f.endsWith(".pdf")) throw new Error("boom"); return preConverted(path.join(FIX, "converted"))(f); };
    const p = await planIngest(kb, { sources: SOURCES, converter: bad });
    expect(p.failed).toEqual([{ ref: "raw/security.pdf", error: "boom" }]);
    expect(p.sources).toHaveLength(2);
  });
});

describe("golden fixture", () => {
  it("v1 extracts: new, duplicate merged, conflict proposed, ids as expected", async () => {
    await ingest();
    const r = apply(cands("candidates-v1.json"));
    expect(r.rejected).toEqual([]);
    expect(r.created.sort()).toEqual(["biz.invoice.issue-window", "biz.rounding.vnd-half-up", "coding.api.validate-input", "sec.logging.no-passwords"]);
    expect(r.merged).toEqual(["biz.invoice.issue-window"]);
    expect(r.proposed).toHaveLength(1);
    const invoice = rules().find((x) => x.id === "biz.invoice.issue-window")!;
    expect(invoice.sources.map((s) => s.ref).sort()).toEqual(["raw/billing-policy.md", "raw/handbook.docx"]);
    expect(invoice.sources.every((s) => s.offset && s.sha)).toBe(true);
    const prop = fs.readdirSync(path.join(rulesDir, PROPOSED_DIR));
    expect(prop).toHaveLength(1);
    const p = matter(fs.readFileSync(path.join(rulesDir, PROPOSED_DIR, prop[0]), "utf8")).data;
    expect(p).toMatchObject({ id: "biz.invoice.issue-window-30d", status: "proposed", conflictsWith: ["biz.invoice.issue-window"] });
    expect(fs.existsSync(path.join(kb, "index.json"))).toBe(true);
  });

  it("re-running extraction on unchanged sources changes no ids and no files", async () => {
    await ingest();
    apply(cands("candidates-v1.json"));
    const snap = () => fs.readdirSync(rulesDir, { recursive: true, encoding: "utf8" }).sort().map((f) => {
      const p = path.join(rulesDir, f); return fs.statSync(p).isFile() ? [f, fs.readFileSync(p, "utf8")] : [f];
    });
    const before = snap();
    expect((await ingest()).sources).toEqual([]);
    const r2 = apply(cands("candidates-v1.json"));
    expect(r2).toMatchObject({ created: [], merged: [], proposed: [], superseded: [], stale: [] });
    expect(snap()).toEqual(before);
  });

  it("meaning change: id matched by offset overlap (overrides the model), old stays active, proposal written", async () => {
    await ingest();
    apply(cands("candidates-v1.json"));
    fs.copyFileSync(path.join(FIX, "v2", "raw", "billing-policy.md"), path.join(kb, "raw", "billing-policy.md"));
    const plan = await ingest(path.join(FIX, "v2", "converted"));
    expect(plan.sources.map((s) => s.ref)).toEqual(["raw/billing-policy.md"]);
    const r = apply(cands("candidates-v2.json"));
    expect(r.idOverrides).toEqual([{ from: "biz.rounding.half-even", to: "biz.rounding.vnd-half-up" }]);
    expect(r.proposed).toHaveLength(1);
    expect(r.proposed[0]).toMatch(/^biz\.rounding\.vnd-half-up@[0-9a-f]{12}$/);
    const active = rules().find((x) => x.id === "biz.rounding.vnd-half-up")!;
    expect(active.status).toBe("active");
    expect(active.statement).toContain("half-up");
    expect(audit().filter((e) => e.event === "item.proposed").map((e) => e.itemId)).toContain("biz.rounding.vnd-half-up");
  });

  it("a second change while a proposal is pending supersedes the older proposal", async () => {
    await ingest();
    apply(cands("candidates-v1.json"));
    const v2 = path.join(kb, "raw", "billing-policy.md");
    fs.copyFileSync(path.join(FIX, "v2", "raw", "billing-policy.md"), v2);
    await ingest(path.join(FIX, "v2", "converted"));
    apply(cands("candidates-v2.json"));
    // v3: another edit
    const v3 = fs.readFileSync(v2, "utf8").replace("half-even", "banker's");
    fs.writeFileSync(v2, v3);
    await ingest(path.join(FIX, "v2", "converted"), { converter: async () => v3 });
    const f = cands("candidates-v2.json");
    f.candidates[0].quote = "All VND amounts shall be rounded banker's to the unit.";
    f.candidates[0].statement = "Round VND amounts banker's.";
    const r = apply(f);
    expect(r.superseded).toHaveLength(1);
    expect(r.proposed).toHaveLength(1);
    const dir = fs.readdirSync(path.join(rulesDir, PROPOSED_DIR));
    expect(dir.filter((x) => x.startsWith("biz.rounding.vnd-half-up@") && x.endsWith(".md"))).toHaveLength(1);
    expect(dir.filter((x) => x.endsWith(".superseded"))).toHaveLength(1);
    expect(audit().map((e) => e.event)).toContain("item.superseded");
  });

  it("an ungrounded quote is rejected, logged, and not written", async () => {
    await ingest();
    const r = apply({ candidates: [{
      source: "raw/billing-policy.md", id: "biz.made-up", domain: "business", modality: "must",
      statement: "Hallucinated.", quote: "Invoices must be paid in gold.",
    } as Candidate] });
    expect(r.rejected).toEqual([{ id: "biz.made-up", source: "raw/billing-policy.md", reason: "ungrounded" }]);
    expect(rules()).toEqual([]);
    expect(audit()).toContainEqual(expect.objectContaining({ event: "item.rejected", itemId: "biz.made-up", reason: "ungrounded" }));
  });

  it("flags a source for docling when >20% of its candidates are dropped", async () => {
    await ingest();
    const mk = (id: string, quote: string): Candidate => ({ source: "raw/billing-policy.md", id, domain: "business", modality: "must", statement: "s", quote });
    const r = apply({ candidates: [mk("a.one", "Invoices must be issued within 5 days of delivery."), mk("a.two", "nope one"), mk("a.three", "nope two")] });
    expect(r.doclingFlags).toEqual([{ ref: "raw/billing-policy.md", dropped: 2, total: 3 }]);
  });

  it("a rule missing from a fully re-swept source goes stale (and back to active when it returns)", async () => {
    await ingest();
    apply(cands("candidates-v1.json"));
    const keep = cands("candidates-v1.json");
    keep.candidates = keep.candidates.filter((c) => c.id !== "sec.logging.no-passwords");
    const r = apply(keep);
    expect(r.stale).toEqual(["sec.logging.no-passwords"]);
    expect(rules().find((x) => x.id === "sec.logging.no-passwords")!.status).toBe("stale");
    const r2 = apply(cands("candidates-v1.json"));
    expect(r2.merged).toEqual(["sec.logging.no-passwords"]);
    expect(rules().find((x) => x.id === "sec.logging.no-passwords")!.status).toBe("active");
  });

  it("an unknown source is rejected without throwing", () => {
    const r = apply({ candidates: [{ source: "raw/nope.md", id: "a.b", domain: "coding", modality: "must", statement: "s", quote: "q" }] });
    expect(r.rejected[0].reason).toContain("unknown source");
  });
});

describe("anchors", () => {
  it("records matching paths and symbols per project", async () => {
    const repo = path.join(kb, "repo");
    fs.mkdirSync(path.join(repo, "billing"), { recursive: true });
    fs.writeFileSync(path.join(repo, "billing", "money.ts"), "export function computeTotal(amount: number) { return Math.round(amount); }\n");
    fs.writeFileSync(path.join(repo, "unrelated.ts"), "export const x = 1;\n");
    expect(computeAnchor(repo, { keywords: ["total"], expanded: ["amount"] })).toEqual({ paths: ["billing/money.ts"], symbols: ["computeTotal"] });
    await ingest();
    apply(cands("candidates-v1.json"), { projects: [{ name: "flooros", root: repo }] });
    const r = rules().find((x) => x.id === "biz.rounding.vnd-half-up")!;
    expect(r.anchors).toEqual({ flooros: { paths: ["billing/money.ts"], symbols: ["computeTotal"] } });
    expect(rules().find((x) => x.id === "coding.api.validate-input")!.anchors).toBeUndefined();
  });
});

const hasMarkitdown = (() => { try { execFileSync("markitdown", ["--help"], { stdio: "ignore" }); return true; } catch { return false; } })();
describe.skipIf(!hasMarkitdown)("real markitdown", () => {
  it("converts the golden pdf and docx so every committed quote is found", async () => {
    const plan = await planIngest(kb, { sources: SOURCES });
    expect(plan.failed).toEqual([]);
    const r = apply(cands("candidates-v1.json"));
    expect(r.rejected).toEqual([]);
  });
});
