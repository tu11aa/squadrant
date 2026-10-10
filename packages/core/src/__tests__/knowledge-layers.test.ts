import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import { resolveProjectRules, kbRulesDir } from "../knowledge/index.js";

let root: string;
const rule = (id: string, body = "KB text.") =>
  `---\nid: ${id}\ndomain: coding\nmodality: must\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n---\n${body}\n`;
function put(dir: string, id: string, body?: string) {
  fs.mkdirSync(path.join(dir, "coding"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coding", `${id}.md`), rule(id, body));
}
function cfg(over: Partial<SquadrantConfig["projects"][string]> = {}): SquadrantConfig {
  const c = getDefaultConfig();
  c.hubVault = path.join(root, "hub");
  c.knowledgeBases = { saitex: { path: path.join(root, "kb", "saitex") }, other: { path: path.join(root, "kb", "other") } };
  c.groups = { saitex: { kb: "saitex" } };
  c.projects = { flooros: { path: "/f", captainName: "f", spokeVault: path.join(root, "spoke"), host: "local", group: "saitex", ...over } };
  return c;
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-layers-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("resolveProjectRules", () => {
  it("merges subscribed KB rules, sorted by id", () => {
    put(kbRulesDir(cfg(), "saitex"), "coding.b");
    put(kbRulesDir(cfg(), "saitex"), "coding.a");
    expect(resolveProjectRules(cfg(), "flooros").rules.map((r) => r.id)).toEqual(["coding.a", "coding.b"]);
  });

  it("project layer replaces a KB rule with the same id (whole-file)", () => {
    put(kbRulesDir(cfg(), "saitex"), "coding.a", "KB text.");
    put(path.join(root, "kb", "saitex", "projects", "flooros", "rules"), "coding.a", "Project text.");
    const r = resolveProjectRules(cfg(), "flooros").rules;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ statement: "Project text.", layer: "project:flooros" });
  });

  it("rulesDisabled removes a KB rule; unknown ids warn (Review Focus 3)", () => {
    put(kbRulesDir(cfg(), "saitex"), "coding.a");
    const res = resolveProjectRules(cfg({ rulesDisabled: ["coding.a", "coding.ghost"] }), "flooros");
    expect(res.rules).toEqual([]);
    expect(res.warnings).toEqual(["rulesDisabled: unknown rule id 'coding.ghost'"]);
  });

  it("missing KB warns, does not throw (Review Focus 3)", () => {
    const res = resolveProjectRules(cfg({ group: undefined, knowledge: ["nope"] }), "flooros");
    expect(res.rules).toEqual([]);
    expect(res.warnings[0]).toContain("knowledge base 'nope' not found");
  });

  it("same id in two subscribed KBs: first subscription wins, warns", () => {
    put(kbRulesDir(cfg(), "saitex"), "coding.a", "Saitex.");
    put(kbRulesDir(cfg(), "other"), "coding.a", "Other.");
    const res = resolveProjectRules(cfg({ knowledge: ["saitex", "other"] }), "flooros");
    expect(res.rules[0].statement).toBe("Saitex.");
    expect(res.warnings[0]).toContain("coding.a");
  });

  it("throws on unknown project", () => {
    expect(() => resolveProjectRules(cfg(), "ghost")).toThrow(/Unknown project 'ghost'/);
  });
});

describe("KB resolution (#936)", () => {
  it("a project inherits its group's KB; knowledge[] adds extra KBs", () => {
    put(kbRulesDir(cfg(), "saitex"), "coding.a");
    put(kbRulesDir(cfg(), "other"), "coding.b");
    const c = cfg({ knowledge: ["other"] });
    expect(resolveProjectRules(c, "flooros").rules.map((r) => r.id)).toEqual(["coding.a", "coding.b"]);
    expect(resolveProjectRules(cfg(), "flooros").rules.map((r) => r.id)).toEqual(["coding.a"]);
  });

  it("KB rules live at <kbRoot>/shared/rules", () => {
    expect(kbRulesDir(cfg(), "saitex")).toBe(path.join(root, "kb", "saitex", "shared", "rules"));
  });

  it("project overlay at <kb>/projects/<p>/rules replaces a shared rule", () => {
    put(kbRulesDir(cfg(), "saitex"), "coding.a", "Shared.");
    put(path.join(root, "kb", "saitex", "projects", "flooros", "rules"), "coding.a", "Overlay.");
    expect(resolveProjectRules(cfg(), "flooros").rules[0]).toMatchObject({ statement: "Overlay.", layer: "project:flooros" });
  });

  it("knowledgeHome repo:docs reads the overlay from <repo>/docs/rules", () => {
    put(kbRulesDir(cfg(), "saitex"), "coding.a", "Shared.");
    put(path.join(root, "repo", "docs", "rules"), "coding.a", "In repo.");
    put(path.join(root, "kb", "saitex", "projects", "flooros", "rules"), "coding.z", "Not read.");
    const c = cfg({ path: path.join(root, "repo"), knowledgeHome: "repo:docs" });
    const rules = resolveProjectRules(c, "flooros").rules;
    expect(rules.map((r) => [r.id, r.statement])).toEqual([["coding.a", "In repo."]]);
  });

  it("a project with no group and no home has no overlay", () => {
    put(path.join(root, "kb", "saitex", "projects", "flooros", "rules"), "coding.z");
    const res = resolveProjectRules(cfg({ group: undefined, knowledge: ["saitex"] }), "flooros");
    expect(res.rules).toEqual([]);
  });

  it("deprecated knowledge.<kb> still resolves the KB path", () => {
    const c = cfg();
    c.knowledge = { legacy: { path: path.join(root, "kb", "legacy") } };
    put(kbRulesDir(c, "legacy"), "coding.l");
    expect(resolveProjectRules({ ...c, projects: { flooros: { ...c.projects.flooros, knowledge: ["legacy"] } } }, "flooros")
      .rules.map((r) => r.id)).toContain("coding.l");
  });
});
