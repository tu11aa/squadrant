// packages/cli/src/commands/__tests__/knowledge.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, saveConfig, loadConfig } from "@squadrant/shared";
import { runKnowledgeInit, runKnowledgeSubscribe, runKnowledgeSources, runKnowledgeReindex, runKnowledgeValidate, runKnowledgeIngest, runKnowledgeApply } from "../knowledge.js";
import { kbRulesDir, kbDir, readIndex } from "@squadrant/core";

let dir: string;
let cfgPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-knowledge-"));
  cfgPath = path.join(dir, "config.json");
  const c = getDefaultConfig();
  c.hubVault = path.join(dir, "hub");
  c.knowledgeBases = { saitex: { path: path.join(dir, "kb", "saitex") } };
  c.projects = { flooros: { path: "/f", captainName: "f", spokeVault: "/v", host: "local" } };
  saveConfig(c, cfgPath);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("knowledge init", () => {
  it("creates the layout, sources.yaml template, and a config entry", () => {
    const r = runKnowledgeInit("saitex", cfgPath);
    for (const rel of ["raw", "shared/rules", "shared/rules/_proposed", "sources.yaml", ".git"]) {
      expect(fs.existsSync(path.join(r.dir, rel))).toBe(true);
    }
    expect(loadConfig(cfgPath).knowledgeBases?.saitex).toBeDefined();
    expect(loadConfig(cfgPath).knowledge).toBeUndefined();
  });
  it("is idempotent and never overwrites sources.yaml", () => {
    const r = runKnowledgeInit("saitex", cfgPath);
    fs.writeFileSync(path.join(r.dir, "sources.yaml"), "- { path: raw/a.md, priority: company }\n");
    const again = runKnowledgeInit("saitex", cfgPath);
    expect(again.created).toEqual([]);
    expect(fs.readFileSync(path.join(r.dir, "sources.yaml"), "utf8")).toContain("raw/a.md");
  });
  it("rejects an invalid kb name", () => {
    expect(() => runKnowledgeInit("Bad Name", cfgPath)).toThrow(/Invalid knowledge base name/);
  });
});

describe("knowledge subscribe", () => {
  it("adds the kb once to the project", () => {
    runKnowledgeInit("saitex", cfgPath);
    expect(runKnowledgeSubscribe("saitex", "flooros", cfgPath)).toEqual(["saitex"]);
    expect(runKnowledgeSubscribe("saitex", "flooros", cfgPath)).toEqual(["saitex"]);
    expect(loadConfig(cfgPath).projects.flooros.knowledge).toEqual(["saitex"]);
  });
  it("errors on unknown project or uninitialised kb", () => {
    expect(() => runKnowledgeSubscribe("saitex", "ghost", cfgPath)).toThrow(/Unknown project 'ghost'/);
    expect(() => runKnowledgeSubscribe("nokb", "flooros", cfgPath)).toThrow(/knowledge init nokb/);
  });
});

describe("knowledge sources", () => {
  it("returns parsed sources", () => {
    const r = runKnowledgeInit("saitex", cfgPath);
    fs.writeFileSync(path.join(r.dir, "sources.yaml"), "- { path: raw/a.md, priority: company }\n");
    expect(runKnowledgeSources("saitex", cfgPath).sources).toEqual([{ path: "raw/a.md", priority: "company" }]);
  });
});

describe("knowledge reindex", () => {
  it("compiles index.json from the KB's rules", () => {
    runKnowledgeInit("saitex", cfgPath);
    const hub = loadConfig(cfgPath);
    fs.mkdirSync(path.join(kbRulesDir(hub, "saitex"), "coding"), { recursive: true });
    fs.writeFileSync(path.join(kbRulesDir(hub, "saitex"), "coding", "coding.a.md"),
      "---\nid: coding.a\ndomain: coding\nmodality: must\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n---\nUse Result.\n");
    const r = runKnowledgeReindex("saitex", cfgPath);
    expect(r).toMatchObject({ count: 1, errors: 0 });
    expect(readIndex(kbDir(hub, "saitex"), "saitex").index?.rules[0].id).toBe("coding.a");
  });
  it("counts proposed separately and names each invalid file", () => {
    runKnowledgeInit("saitex", cfgPath);
    const hub = loadConfig(cfgPath);
    const rules = kbRulesDir(hub, "saitex");
    const md = (id: string) => `---\nid: ${id}\ndomain: coding\nmodality: must\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n---\nX.\n`;
    fs.mkdirSync(path.join(rules, "_proposed"), { recursive: true });
    fs.writeFileSync(path.join(rules, "coding.a.md"), md("coding.a"));
    fs.writeFileSync(path.join(rules, "_proposed", "coding.b.md"), md("coding.b"));
    fs.writeFileSync(path.join(rules, "bad.md"), "---\nid: Bad\n---\nx\n");
    const r = runKnowledgeReindex("saitex", cfgPath);
    expect(r).toMatchObject({ count: 1, proposed: 1, errors: 1 });
    expect(r.invalid[0].file).toContain("bad.md");
    expect(readIndex(kbDir(hub, "saitex"), "saitex").index?.rules.map((x) => x.id)).toEqual(["coding.a"]);
  });
  it("fails clearly on an uninitialised KB", () => {
    expect(() => runKnowledgeReindex("nope", cfgPath)).toThrow(/does not exist/);
  });
});

describe("kb name validation on every command", () => {
  it("subscribe/sources/reindex reject traversal names", () => {
    expect(() => runKnowledgeSubscribe("../x", "flooros", cfgPath)).toThrow(/Invalid knowledge base name/);
    expect(() => runKnowledgeSources("../x", cfgPath)).toThrow(/Invalid knowledge base name/);
    expect(() => runKnowledgeReindex("../x", cfgPath)).toThrow(/Invalid knowledge base name/);
  });
});

describe("knowledge init index", () => {
  it("writes an empty index once and never overwrites it", () => {
    const r = runKnowledgeInit("saitex", cfgPath);
    const idx = path.join(r.dir, "index.json");
    expect(fs.existsSync(idx)).toBe(true);
    fs.writeFileSync(idx, fs.readFileSync(idx, "utf8") + " ");
    const before = fs.readFileSync(idx, "utf8");
    expect(runKnowledgeInit("saitex", cfgPath).created).toEqual([]);
    expect(fs.readFileSync(idx, "utf8")).toBe(before);
  });
  it("leaves doctor with no failing index line", async () => {
    runKnowledgeInit("saitex", cfgPath);
    const { knowledgeDoctorLines } = await import("../doctor.js");
    const lines = knowledgeDoctorLines(loadConfig(cfgPath), () => true);
    expect(lines.filter((l) => !l.ok && !l.warnOnly)).toEqual([]);
  });
});

describe("knowledge validate", () => {
  it("fails on a quote not in the source, passes once fixed, and reads domains from KB config", () => {
    const r = runKnowledgeInit("saitex", cfgPath);
    const hub = loadConfig(cfgPath);
    fs.mkdirSync(path.join(r.dir, "raw"), { recursive: true });
    fs.writeFileSync(path.join(r.dir, "raw", "a.md"), "use Result everywhere");
    const file = path.join(kbRulesDir(hub, "saitex"), "coding.a.md");
    const md = (q: string) => `---\nid: coding.a\ndomain: coding\nmodality: must\nstatus: active\nsources:\n  - { ref: raw/a.md, sha: s, quote: "${q}" }\n---\nX.\n`;
    fs.writeFileSync(file, md("use Option"));
    expect(runKnowledgeValidate("saitex", cfgPath).ok).toBe(false);
    fs.writeFileSync(file, md("use Result"));
    expect(runKnowledgeValidate("saitex", cfgPath).ok).toBe(true);
    const cfg = loadConfig(cfgPath);
    cfg.knowledgeBases = { saitex: { ...cfg.knowledgeBases!.saitex, domains: ["git"] } };
    saveConfig(cfg, cfgPath);
    const v = runKnowledgeValidate("saitex", cfgPath);
    expect(v.ok).toBe(true);
    expect(v.checks.some((c) => c.level === "warn")).toBe(true);
  });
});

describe("knowledge ingest / apply", () => {
  it("ingest plans a changed md source; apply writes the rule and is idempotent", async () => {
    const { dir: kbRoot } = runKnowledgeInit("saitex", cfgPath);
    fs.writeFileSync(path.join(kbRoot, "sources.yaml"), "- { path: raw/**, priority: company }\n");
    fs.writeFileSync(path.join(kbRoot, "raw", "p.md"), "# P\n\nInvoices must be issued within 5 days.\n");
    const plan = await runKnowledgeIngest("saitex", {}, cfgPath);
    expect(plan.sources.map((s) => s.ref)).toEqual(["raw/p.md"]);
    const cand = path.join(dir, "cand.json");
    fs.writeFileSync(cand, JSON.stringify({ complete: ["raw/p.md"], candidates: [{
      source: "raw/p.md", id: "biz.invoice.window", domain: "business", modality: "must",
      statement: "Issue invoices within 5 days.", quote: "Invoices must be issued within 5 days.",
    }] }));
    process.env.SQUADRANT_AUDIT_DIR = path.join(dir, "audit");
    try {
      expect(runKnowledgeApply("saitex", cand, cfgPath).created).toEqual(["biz.invoice.window"]);
      expect(runKnowledgeApply("saitex", cand, cfgPath)).toMatchObject({ created: [], merged: [] });
    } finally { delete process.env.SQUADRANT_AUDIT_DIR; }
    expect(readIndex(kbRoot, "saitex").index?.rules.map((r) => r.id)).toEqual(["biz.invoice.window"]);
    expect((await runKnowledgeIngest("saitex", {}, cfgPath)).sources).toEqual([]);
  });
});
