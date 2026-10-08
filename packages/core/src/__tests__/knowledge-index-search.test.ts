import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Rule } from "@squadrant/shared";
import { compileIndex, writeIndex, readIndex, searchRules, kbDir } from "../knowledge/index.js";

const mk = (id: string, over: Partial<Rule> = {}): Rule => ({
  id, domain: "business", modality: "must", status: "active",
  sources: [{ ref: "r", sha: "s", quote: "q" }],
  statement: "VND amounts are rounded half-up.", body: "", file: `/x/${id}.md`, layer: "kb:saitex",
  ...over,
});

let hub: string;
beforeEach(() => { hub = fs.mkdtempSync(path.join(os.tmpdir(), "kb-idx-")); });
afterEach(() => fs.rmSync(hub, { recursive: true, force: true }));

describe("index", () => {
  it("compiles, writes, reads back", () => {
    const idx = compileIndex("saitex", [mk("biz.a")], new Date("2026-10-08T00:00:00Z"));
    expect(idx).toMatchObject({ kb: "saitex", compiledAt: "2026-10-08T00:00:00.000Z" });
    expect(idx.rules[0]).toMatchObject({ id: "biz.a", statement: "VND amounts are rounded half-up." });
    fs.mkdirSync(kbDir(hub, "saitex"), { recursive: true });
    const file = writeIndex(hub, "saitex", idx);
    expect(file).toBe(path.join(kbDir(hub, "saitex"), "index.json"));
    expect(readIndex(hub, "saitex")).toEqual({ index: idx });
  });
  it("reports missing and corrupt index", () => {
    expect(readIndex(hub, "saitex").problem).toContain("missing");
    fs.mkdirSync(kbDir(hub, "saitex"), { recursive: true });
    fs.writeFileSync(path.join(kbDir(hub, "saitex"), "index.json"), "{not json");
    expect(readIndex(hub, "saitex").problem).toContain("corrupt");
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
  it("empty query returns nothing", () => {
    expect(searchRules(rules, "   ")).toEqual([]);
  });
});
