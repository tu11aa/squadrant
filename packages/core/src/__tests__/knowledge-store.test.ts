// packages/core/src/__tests__/knowledge-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadRulesDir, splitStatement, kbRulesDir, projectRulesDir } from "../knowledge/index.js";

let dir: string;
function write(rel: string, text: string) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
export function ruleMd(id: string, extra = "", body = "Statement here.\n\nRationale.") {
  return `---\nid: ${id}\ndomain: ${id.split(".")[0] === "biz" ? "business" : "coding"}\nmodality: must\nstatus: active\n${extra}sources:\n  - { ref: raw/a.md, sha: abc, quote: "q" }\n---\n${body}\n`;
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-store-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("paths", () => {
  it("builds kb and project layer dirs", () => {
    expect(kbRulesDir("/hub", "saitex")).toBe(path.join("/hub", "knowledge", "saitex", "rules"));
    expect(projectRulesDir("/spoke")).toBe(path.join("/spoke", "knowledge", "rules"));
  });
});

describe("splitStatement", () => {
  it("returns the first paragraph, trimmed and single-lined", () => {
    expect(splitStatement("\n VND amounts are\nrounded half-up.\n\nWhy: tax.")).toBe("VND amounts are rounded half-up.");
  });
});

describe("loadRulesDir", () => {
  it("returns empty for a missing dir", () => {
    expect(loadRulesDir(path.join(dir, "nope"), "kb:x")).toEqual({ rules: [], errors: [] });
  });

  it("loads valid rules with statement, layer and file", () => {
    write("business/biz.a.md", ruleMd("biz.a"));
    const r = loadRulesDir(dir, "kb:saitex");
    expect(r.errors).toEqual([]);
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]).toMatchObject({ id: "biz.a", statement: "Statement here.", layer: "kb:saitex" });
    expect(r.rules[0].file).toBe(path.join(dir, "business/biz.a.md"));
  });

  it("skips malformed files and reports them (Review Focus 1)", () => {
    write("coding/bad.md", "---\nid: [unclosed\n---\nx");
    write("coding/nomod.md", "---\nid: coding.x\ndomain: coding\nstatus: active\nsources: []\n---\nx");
    write("coding/coding.ok.md", ruleMd("coding.ok"));
    const r = loadRulesDir(dir, "kb:x");
    expect(r.rules.map((x) => x.id)).toEqual(["coding.ok"]);
    expect(r.errors.map((e) => path.basename(e.file)).sort()).toEqual(["bad.md", "nomod.md"]);
  });

  it("duplicate id: first path (sorted) wins, duplicate reported (Review Focus 2)", () => {
    write("a-domain/one.md", ruleMd("coding.dup"));
    write("b-domain/two.md", ruleMd("coding.dup"));
    const r = loadRulesDir(dir, "kb:x");
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0].file).toContain("a-domain");
    expect(r.errors[0].problems[0]).toContain("duplicate id coding.dup");
  });

  it("excludes _proposed by default (Review Focus 4), includes on request", () => {
    write("coding/coding.live.md", ruleMd("coding.live"));
    write("_proposed/coding.pending@abc.md", ruleMd("coding.pending"));
    expect(loadRulesDir(dir, "kb:x").rules.map((r) => r.id)).toEqual(["coding.live"]);
    expect(loadRulesDir(dir, "kb:x", { includeProposed: true }).rules.map((r) => r.id).sort())
      .toEqual(["coding.live", "coding.pending"]);
  });
});

describe("front matter safety", () => {
  it.each(["js", "javascript"])("rejects ---%s front matter without executing it", (tag) => {
    const g = globalThis as Record<string, unknown>;
    delete g.PWNED_KB;
    write("coding/evil.md", `---${tag}\n{ id: (globalThis.PWNED_KB = 1, "coding.evil") }\n---\nbody\n`);
    write("coding/coding.ok.md", ruleMd("coding.ok"));
    const r = loadRulesDir(dir, "kb:x");
    expect(g.PWNED_KB).toBeUndefined();
    expect(r.rules.map((x) => x.id)).toEqual(["coding.ok"]);
    expect(r.errors.map((e) => path.basename(e.file))).toEqual(["evil.md"]);
  });
});
