import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, saveConfig, loadConfig } from "@squadrant/shared";
import { kbRulesDir } from "@squadrant/core";
import { runRulesSearch, runRulesShow, resolveRulesProject, formatRule } from "../rules.js";

let dir: string;
let cfgPath: string;
const rule = (id: string, status = "active", extra = "") =>
  `---\nid: ${id}\ndomain: business\nmodality: must\nstatus: ${status}\n${extra}sources:\n  - { ref: raw/Policy-v3.pdf, sha: s, loc: "p.12", quote: q }\n---\nVND amounts are rounded half-up.\n`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-rules-"));
  cfgPath = path.join(dir, "config.json");
  const c = getDefaultConfig();
  c.hubVault = path.join(dir, "hub");
  c.projects = { flooros: { path: path.join(dir, "flooros"), captainName: "f", spokeVault: path.join(dir, "spoke"), host: "local", knowledge: ["saitex"] } };
  saveConfig(c, cfgPath);
  const rd = path.join(kbRulesDir(c.hubVault, "saitex"), "business");
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, "biz.invoice.vnd-rounding.md"), rule("biz.invoice.vnd-rounding", "active", "triggers:\n  keywords: [invoice]\n"));
  fs.writeFileSync(path.join(rd, "biz.old.md"), rule("biz.old", "retired", "triggers:\n  keywords: [invoice]\n"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("resolveRulesProject", () => {
  it("prefers --project, then SQUADRANT_CREW_PROJECT, then cwd", () => {
    const c = loadConfig(cfgPath);
    expect(resolveRulesProject(c, { project: "flooros", env: {} })).toBe("flooros");
    expect(resolveRulesProject(c, { env: { SQUADRANT_CREW_PROJECT: "flooros" }, cwd: "/" })).toBe("flooros");
    expect(resolveRulesProject(c, { env: {}, cwd: path.join(dir, "flooros", "src") })).toBe("flooros");
  });
  it("fails clearly outside any project (Review Focus 5)", () => {
    expect(() => resolveRulesProject(loadConfig(cfgPath), { env: {}, cwd: "/" })).toThrow(/--project/);
  });
});

describe("rules search/show", () => {
  it("search returns active rules by default, all with --all", () => {
    expect(runRulesSearch("invoice", { project: "flooros" }, cfgPath).map((h) => h.rule.id)).toEqual(["biz.invoice.vnd-rounding"]);
    expect(runRulesSearch("invoice", { project: "flooros", all: true }, cfgPath).map((h) => h.rule.id).sort())
      .toEqual(["biz.invoice.vnd-rounding", "biz.old"]);
  });
  it("show finds by id and formats with modality and source", () => {
    const r = runRulesShow("biz.invoice.vnd-rounding", { project: "flooros" }, cfgPath);
    const text = formatRule(r);
    expect(text).toContain("MUST VND amounts are rounded half-up.");
    expect(text).toContain("raw/Policy-v3.pdf p.12");
  });
  it("show errors on an unknown id", () => {
    expect(() => runRulesShow("nope", { project: "flooros" }, cfgPath)).toThrow(/No rule 'nope'/);
  });
  it("show hides retired rules unless --all (default statuses are active+stale)", () => {
    expect(() => runRulesShow("biz.old", { project: "flooros" }, cfgPath)).toThrow(/No rule 'biz.old'/);
    expect(runRulesShow("biz.old", { project: "flooros", all: true }, cfgPath).status).toBe("retired");
  });
  it("skips a malformed rule file and reports it on stderr without failing search (Review Focus 1)", () => {
    const rd = path.join(kbRulesDir(loadConfig(cfgPath).hubVault, "saitex"), "business");
    fs.writeFileSync(path.join(rd, "biz.broken.md"), "---\nid: [unclosed\n---\nbody\n");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(runRulesSearch("invoice", { project: "flooros" }, cfgPath).map((h) => h.rule.id)).toEqual(["biz.invoice.vnd-rounding"]);
      expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain("biz.broken.md");
    } finally {
      err.mockRestore();
    }
  });
});
