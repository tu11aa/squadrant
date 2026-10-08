import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import { resolveProjectRules, kbRulesDir, projectRulesDir } from "../knowledge/index.js";

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
  c.projects = { flooros: { path: "/f", captainName: "f", spokeVault: path.join(root, "spoke"), host: "local", knowledge: ["saitex"], ...over } };
  return c;
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-layers-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("resolveProjectRules", () => {
  it("merges subscribed KB rules, sorted by id", () => {
    put(kbRulesDir(path.join(root, "hub"), "saitex"), "coding.b");
    put(kbRulesDir(path.join(root, "hub"), "saitex"), "coding.a");
    expect(resolveProjectRules(cfg(), "flooros").rules.map((r) => r.id)).toEqual(["coding.a", "coding.b"]);
  });

  it("project layer replaces a KB rule with the same id (whole-file)", () => {
    put(kbRulesDir(path.join(root, "hub"), "saitex"), "coding.a", "KB text.");
    put(projectRulesDir(path.join(root, "spoke")), "coding.a", "Project text.");
    const r = resolveProjectRules(cfg(), "flooros").rules;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ statement: "Project text.", layer: "project:flooros" });
  });

  it("rulesDisabled removes a KB rule; unknown ids warn (Review Focus 3)", () => {
    put(kbRulesDir(path.join(root, "hub"), "saitex"), "coding.a");
    const res = resolveProjectRules(cfg({ rulesDisabled: ["coding.a", "coding.ghost"] }), "flooros");
    expect(res.rules).toEqual([]);
    expect(res.warnings).toEqual(["rulesDisabled: unknown rule id 'coding.ghost'"]);
  });

  it("missing KB warns, does not throw (Review Focus 3)", () => {
    const res = resolveProjectRules(cfg({ knowledge: ["nope"] }), "flooros");
    expect(res.rules).toEqual([]);
    expect(res.warnings[0]).toContain("knowledge base 'nope' not found");
  });

  it("same id in two subscribed KBs: first subscription wins, warns", () => {
    put(kbRulesDir(path.join(root, "hub"), "saitex"), "coding.a", "Saitex.");
    put(kbRulesDir(path.join(root, "hub"), "other"), "coding.a", "Other.");
    const res = resolveProjectRules(cfg({ knowledge: ["saitex", "other"] }), "flooros");
    expect(res.rules[0].statement).toBe("Saitex.");
    expect(res.warnings[0]).toContain("coding.a");
  });

  it("throws on unknown project", () => {
    expect(() => resolveProjectRules(cfg(), "ghost")).toThrow(/Unknown project 'ghost'/);
  });
});
