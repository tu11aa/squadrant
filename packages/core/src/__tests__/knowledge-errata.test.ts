import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, type KnowledgeErratum, type SquadrantConfig } from "@squadrant/shared";
import {
  applyCandidates, loadErrata, loadRulesDir, kbDir, kbRulesDir, planIngest, renderReport, validateKb,
  PROPOSED_DIR, type CandidateFile, type Converter,
} from "../knowledge/index.js";

const FIX = path.join(__dirname, "fixtures", "knowledge-golden");
const VND = "All VND amounts shall be rounded half-up to the unit.";
const INVOICE = "Invoices must be issued within 5 days of delivery.";
let kb: string;
let rulesDir: string;

const preConverted = (dir: string): Converter => async (file) => fs.readFileSync(path.join(dir, `${path.basename(file)}.md`), "utf8");
const cands = () => JSON.parse(fs.readFileSync(path.join(FIX, "candidates-v1.json"), "utf8")) as CandidateFile;
const billing = (f: CandidateFile): CandidateFile => ({ candidates: f.candidates.filter((c) => c.source === "raw/billing-policy.md") });
const erratum = (quote: string, extra: Partial<KnowledgeErratum> = {}): KnowledgeErratum => ({ id: "bill.stale", ref: "raw/billing-policy.md", quote, reason: "out of date", ...extra });
const apply = (f: CandidateFile, errata?: KnowledgeErratum[]) => applyCandidates(f, { kb: "t", kbRoot: kb, rulesDir, errata });
const ingest = () => planIngest(kb, { sources: [{ path: "raw/**", priority: "company" }], converter: preConverted(path.join(FIX, "converted")) });

beforeEach(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), "kb-errata-"));
  rulesDir = path.join(kb, "shared", "rules");
  fs.cpSync(path.join(FIX, "raw"), path.join(kb, "raw"), { recursive: true });
});
afterEach(() => fs.rmSync(kb, { recursive: true, force: true }));

describe("loadErrata", () => {
  const write = (t: string) => fs.writeFileSync(path.join(kb, "errata.yaml"), t);
  it("a missing file is empty, not an error", () => {
    expect(loadErrata(kb)).toEqual({ errata: [], errors: [] });
  });
  it("loads entries (a YAML date for `at` is fine) and reports invalid ones by index", () => {
    write(`- id: a.one\n  ref: raw/x.md\n  quote: q\n  reason: r\n  at: 2026-10-08\n- id: BAD\n  ref: raw/x.md\n`);
    const r = loadErrata(kb);
    expect(r.errata.map((e) => e.id)).toEqual(["a.one"]);
    expect(r.errata[0].at).toBe("2026-10-08");
    expect(r.errors).toEqual([expect.stringMatching(/^entry 1: id/), expect.stringContaining("quote"), expect.stringContaining("reason")]);
  });
  it("non-list YAML is an error, not a throw", () => {
    write("id: oops\n");
    expect(loadErrata(kb).errors).toEqual(["errata.yaml must be a YAML list of entries"]);
  });
});

describe("apply with errata (spec 2026-10-13 §4.2)", () => {
  it("rejects an overlapping candidate as errata:<id>; a candidate elsewhere in the same file passes", async () => {
    await ingest();
    const r = apply(billing(cands()), [erratum(VND)]);
    expect(r.rejected).toEqual([{ id: "biz.rounding.vnd-half-up", source: "raw/billing-policy.md", reason: "errata:bill.stale" }]);
    expect(r.created).toEqual(["biz.invoice.issue-window"]);
    expect(r.proposed).toEqual([]);
    expect(fs.existsSync(path.join(rulesDir, PROPOSED_DIR))).toBe(false);
    expect(loadRulesDir(rulesDir, "kb:t").rules.map((x) => x.id)).toEqual(["biz.invoice.issue-window"]);
  });

  it("a rejection is not counted as a dropped candidate for the docling flag", async () => {
    await ingest();
    const r = apply(billing(cands()), [erratum(VND)]);
    expect(r.doclingFlags).toEqual([]);
  });

  it("works for an erratum on a non-raw source", async () => {
    fs.mkdirSync(path.join(kb, "docs"));
    fs.writeFileSync(path.join(kb, "docs", "h.md"), "# H\n\nRun commitlint on every commit.\n\nKeep PRs small.\n");
    await planIngest(kb, { sources: [{ path: "docs/**", priority: "project" }] });
    const f: CandidateFile = { candidates: [
      { source: "docs/h.md", id: "coding.commitlint", domain: "coding", modality: "must", statement: "Run commitlint.", quote: "Run commitlint on every commit." },
      { source: "docs/h.md", id: "coding.small-prs", domain: "coding", modality: "should", statement: "Keep PRs small.", quote: "Keep PRs small." },
    ] };
    const r = apply(f, [{ id: "hb.commitlint", ref: "docs/h.md", quote: "Run commitlint on every commit.", reason: "not enforced" }]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["errata:hb.commitlint"]);
    expect(r.created).toEqual(["coding.small-prs"]);
  });

  it("reports an erratum whose quote is no longer found as orphaned", async () => {
    await ingest();
    const r = apply(billing(cands()), [erratum("a sentence the raw file no longer has")]);
    expect(r.orphanedErrata).toEqual([{ id: "bill.stale", ref: "raw/billing-policy.md" }]);
    expect(r.created).toHaveLength(2);
  });

  it("an erratum for a ref with no candidates in this file is not checked", async () => {
    await ingest();
    const r = apply(billing(cands()), [{ id: "other", ref: "raw/security.pdf", quote: "missing", reason: "r" }]);
    expect(r.orphanedErrata).toEqual([]);
  });

  it("no errata (absent or empty) changes nothing", async () => {
    await ingest();
    const r = apply(billing(cands()));
    expect(r.created).toHaveLength(2);
    expect(r.rejected).toEqual([]);
    expect(r.orphanedErrata).toEqual([]);
  });
});

describe("validate and REPORT.md with errata", () => {
  const rule = (quote: string) => `---\nid: coding.a\ndomain: coding\nmodality: must\nstatus: active\nsources:\n  - { ref: raw/a.md, sha: abc, quote: "${quote}" }\n---\nS.\n`;

  it("warns on a live rule grounded in an erratum passage, and does not fail", () => {
    fs.writeFileSync(path.join(kb, "raw", "a.md"), "alpha beta gamma");
    fs.mkdirSync(path.join(rulesDir, "coding"), { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "coding", "a.md"), rule("beta"));
    const r = validateKb({ rulesDir, kbRoot: kb, sources: [], errata: [{ id: "a.err", ref: "raw/a.md", quote: "alpha beta", reason: "stale" }] });
    expect(r.ok).toBe(true);
    expect(r.checks).toContainEqual({ level: "warn", message: expect.stringContaining("coding.a: grounded in erratum a.err") });
  });

  it("no warning when the rule's quote is elsewhere in the file", () => {
    fs.writeFileSync(path.join(kb, "raw", "a.md"), "alpha beta gamma");
    fs.mkdirSync(path.join(rulesDir, "coding"), { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "coding", "a.md"), rule("gamma"));
    const r = validateKb({ rulesDir, kbRoot: kb, sources: [], errata: [{ id: "a.err", ref: "raw/a.md", quote: "alpha", reason: "stale" }] });
    expect(r.checks.some((c) => c.level === "warn")).toBe(false);
  });

  it("REPORT.md lists orphaned errata", async () => {
    await ingest();
    fs.writeFileSync(path.join(kb, "errata.yaml"), `- id: bill.stale\n  ref: raw/billing-policy.md\n  quote: gone from the raw file\n  reason: r\n`);
    const cfg: SquadrantConfig = getDefaultConfig();
    cfg.knowledgeBases = { t: { path: kb } };
    const report = renderReport(cfg, "t", { pass: "incremental", now: new Date("2026-10-13T00:00:00Z") });
    expect(report).toContain("## Errata to re-check (1)");
    expect(report).toContain("bill.stale");
    expect(kbDir(cfg, "t")).toBe(kb);
    expect(kbRulesDir(cfg, "t")).toBe(rulesDir);
  });
});
