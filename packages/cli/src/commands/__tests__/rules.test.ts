import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, saveConfig, loadConfig } from "@squadrant/shared";
import { kbRulesDir } from "@squadrant/core";
import { runRulesSearch, runRulesShow, runRulesList, resolveRulesProject, formatRule, renderSearch, renderList, parseLimit } from "../rules.js";
import type { SearchHit } from "@squadrant/core";

let dir: string;
let cfgPath: string;
const rule = (id: string, status = "active", extra = "") =>
  `---\nid: ${id}\ndomain: business\nmodality: must\nstatus: ${status}\n${extra}sources:\n  - { ref: raw/Policy-v3.pdf, sha: s, loc: "p.12", quote: q }\n---\nVND amounts are rounded half-up.\n`;

beforeEach(() => {
  process.env.SQUADRANT_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "audit-rules-"));
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
afterEach(() => {
  fs.rmSync(process.env.SQUADRANT_AUDIT_DIR!, { recursive: true, force: true });
  delete process.env.SQUADRANT_AUDIT_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

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

describe("rules output rendering", () => {
  const hit = (id: string, score: number): SearchHit => ({
    rule: { id, domain: "d", modality: "must", status: "active", sources: [], statement: `S-${id}`, body: "", file: "", layer: "kb:x" },
    score, matched: 1, curated: false,
  });
  const hits = ["a", "b", "c", "d", "e", "f", "g"].map((id, i) => hit(id, 20 - i));

  it("limits to 5 by default and says how many were cut", () => {
    const out = renderSearch(hits, {});
    expect(out).toHaveLength(6);
    expect(out[5]).toBe("(+2 more; use --limit)");
    expect(out[0]).toContain("score: 20");
  });
  it("--limit overrides; no truncation note when everything fits", () => {
    expect(renderSearch(hits, { limit: "7" })).toHaveLength(7);
    expect(renderSearch(hits, { limit: 2 }).at(-1)).toBe("(+5 more; use --limit)");
  });
  it("rejects a bad --limit", () => {
    expect(() => parseLimit("0")).toThrow(/--limit/);
    expect(() => parseLimit("abc")).toThrow(/--limit/);
  });
  it("--brief is one line per rule; --ids-only is bare ids", () => {
    expect(renderSearch(hits.slice(0, 1), { brief: true })).toEqual(["[20] MUST a: S-a"]);
    expect(renderSearch(hits.slice(0, 2), { idsOnly: true })).toEqual(["a", "b"]);
  });
  it("always prints (no matching rules) for zero hits, in every mode", () => {
    for (const o of [{}, { brief: true }, { idsOnly: true }]) expect(renderSearch([], o)).toEqual(["(no matching rules)"]);
    expect(runRulesSearch("approver role keycloak", { project: "flooros" }, cfgPath)).toEqual([]);
  });
  it("list returns resolved rules sorted, hides retired unless --all", () => {
    expect(renderList(runRulesList({ project: "flooros" }, cfgPath), { brief: true }))
      .toEqual(["MUST biz.invoice.vnd-rounding: VND amounts are rounded half-up."]);
    expect(runRulesList({ project: "flooros", all: true }, cfgPath).map((r) => r.id)).toEqual(["biz.invoice.vnd-rounding", "biz.old"]);
    expect(renderList([], {})).toEqual(["(no rules)"]);
  });
});

describe("rules audit log (#935)", () => {
  const read = () => fs.readdirSync(process.env.SQUADRANT_AUDIT_DIR!).flatMap((f) =>
    fs.readFileSync(path.join(process.env.SQUADRANT_AUDIT_DIR!, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
  it("search logs item.searched with the query truncated to 200 chars", () => {
    runRulesSearch("invoice " + "x".repeat(300), { project: "flooros" }, cfgPath);
    const [e] = read();
    expect(e).toMatchObject({ event: "item.searched", domain: "rules", project: "flooros" });
    expect(e.query).toHaveLength(200);
  });
  it("show logs item.shown", () => {
    runRulesShow("biz.invoice.vnd-rounding", { project: "flooros" }, cfgPath);
    expect(read()[0]).toMatchObject({ event: "item.shown", itemId: "biz.invoice.vnd-rounding", kb: "saitex", level: "group" });
  });
});
