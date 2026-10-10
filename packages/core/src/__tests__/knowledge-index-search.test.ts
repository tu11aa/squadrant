import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Rule } from "@squadrant/shared";
import { compileIndex, writeIndex, readIndex, searchRules } from "../knowledge/index.js";

const mk = (id: string, over: Partial<Rule> = {}): Rule => ({
  id, domain: "business", modality: "must", status: "active",
  sources: [{ ref: "r", sha: "s", quote: "q" }],
  statement: "VND amounts are rounded half-up.", body: "", file: `/x/${id}.md`, layer: "kb:saitex",
  ...over,
});

let hub: string;
let kbRoot: string;
beforeEach(() => { hub = fs.mkdtempSync(path.join(os.tmpdir(), "kb-idx-")); kbRoot = path.join(hub, "saitex"); });
afterEach(() => fs.rmSync(hub, { recursive: true, force: true }));

describe("index", () => {
  it("compiles, writes, reads back", () => {
    const idx = compileIndex("saitex", [mk("biz.a")], new Date("2026-10-08T00:00:00Z"));
    expect(idx).toMatchObject({ kb: "saitex", compiledAt: "2026-10-08T00:00:00.000Z" });
    expect(idx.rules[0]).toMatchObject({ id: "biz.a", statement: "VND amounts are rounded half-up." });
    fs.mkdirSync(kbRoot, { recursive: true });
    const file = writeIndex(kbRoot, idx);
    expect(file).toBe(path.join(kbRoot, "index.json"));
    expect(readIndex(kbRoot, "saitex")).toEqual({ index: idx });
  });
  it("reports missing and corrupt index", () => {
    expect(readIndex(kbRoot, "saitex").problem).toContain("missing");
    fs.mkdirSync(kbRoot, { recursive: true });
    fs.writeFileSync(path.join(kbRoot, "index.json"), "{not json");
    expect(readIndex(kbRoot, "saitex").problem).toContain("corrupt");
  });
});

describe("searchRules", () => {
  const rules = [
    mk("biz.invoice.vnd-rounding", { triggers: { keywords: ["invoice", "vnd"], when: "Computing monetary amounts" } }),
    mk("coding.api.result-type", { domain: "coding", statement: "Use the Result type for errors.", triggers: { keywords: ["error"] } }),
    mk("biz.old", { status: "retired", triggers: { keywords: ["invoice"] } }),
  ];
  it("ranks keyword hits above statement hits, excludes retired by default", () => {
    const hits = searchRules(rules, "invoice rounding");
    expect(hits.map((h) => h.rule.id)).toEqual(["biz.invoice.vnd-rounding"]);
  });
  it("matches the when sentence", () => {
    expect(searchRules(rules, "monetary")[0].rule.id).toBe("biz.invoice.vnd-rounding");
  });
  it("includes other statuses when asked", () => {
    const ids = searchRules(rules, "invoice", { statuses: ["active", "stale", "proposed", "retired"] }).map((h) => h.rule.id);
    expect(ids).toContain("biz.old");
  });
  it("requires 2 matched terms for multi-term queries, falls back to single-term hits", () => {
    const rs = [
      mk("a.both", { statement: "alpha beta together." }),
      mk("a.one", { statement: "alpha only." }),
    ];
    expect(searchRules(rs, "alpha beta").map((h) => h.rule.id)).toEqual(["a.both"]);
    expect(searchRules(rs, "alpha zeta").map((h) => h.rule.id)).toEqual(["a.both", "a.one"]);
  });
  it("keeps a single-term hit on a curated keyword alongside multi-term hits", () => {
    const rs = [
      mk("w.det", { statement: "No clocks.", triggers: { keywords: ["workflow"] } }),
      mk("w.http", { statement: "No http in tx." }),
      mk("w.noise", { statement: "workflow stuff mentioned once." }),
    ];
    const ids = searchRules(rs, "workflow http").map((h) => h.rule.id);
    expect(ids).toContain("w.det");
    expect(ids).not.toContain("w.noise");
  });
  it("weights id/keywords above rationale and sorts by score", () => {
    const rs = [
      mk("x.rationale", { statement: "Unrelated.", body: "Unrelated.\n\nWhy: cache the token.", }),
      mk("x.cache-token", { statement: "Unrelated." }),
    ];
    const hits = searchRules(rs, "cache token");
    expect(hits.map((h) => h.rule.id)).toEqual(["x.cache-token", "x.rationale"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });
  it("empty query returns nothing", () => {
    expect(searchRules(rules, "   ")).toEqual([]);
  });
});
