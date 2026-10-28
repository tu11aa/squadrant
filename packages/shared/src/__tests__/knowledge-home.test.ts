// KB phase 2 (#979) foundation: home resolution (D5), read-set order, D3/D4 validation, source-ref normal form.
import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  getDefaultConfig, resolveKnowledgeHome, homeKb, homeAuditKb, projectRulesHome, subscribedKbs, knowledgeReadSet,
  normalizeSourceRef, validateItemDomain, type SquadrantConfig,
} from "../index.js";

const kbRoot = (kb: string) => path.join(os.homedir(), "squadrant", "kb", kb);
const proj = (over: Record<string, unknown> = {}) => ({ path: "/repo/x", captainName: "c", spokeVault: "/v", host: "local", ...over });

function cfg(): SquadrantConfig {
  const c = getDefaultConfig();
  c.groups = { acme: { kb: "acme" }, loose: {} };
  c.projects = {
    projA: proj({ group: "acme", knowledge: ["initech"] }), // rule 2
    projB: proj({ group: "acme", knowledgeHome: "kb:globex" }), // rule 1, kb:
    projC: proj({ path: "/repo/c", group: "acme", knowledgeHome: "repo:docs" }), // rule 1, repo:docs
    projD: proj({ group: "loose" }), // rule 3
    projE: proj(), // rule 4
    projF: proj({ knowledgeHome: "svn:docs" }), // unrecognized
  };
  return c;
}

describe("resolveKnowledgeHome (D5)", () => {
  it("rule 1: knowledgeHome kb:<name> wins over the group", () => {
    const h = resolveKnowledgeHome(cfg(), "projB");
    expect(h).toMatchObject({ kind: "kb", kb: "globex" });
    expect(h!.dir("decisions")).toBe(path.join(kbRoot("globex"), "projects", "projB", "decisions"));
  });
  it("rule 1: repo:docs puts every domain under <repo>/docs", () => {
    const h = resolveKnowledgeHome(cfg(), "projC");
    expect(h).toMatchObject({ kind: "repo" });
    expect(h!.dir("rules")).toBe(path.join("/repo/c", "docs", "rules"));
    expect(h!.dir("wiki")).toBe(path.join("/repo/c", "docs", "wiki"));
  });
  it("rule 2: a group mapped to a KB → <kb>/projects/<p>/", () => {
    const h = resolveKnowledgeHome(cfg(), "projA");
    expect(h).toMatchObject({ kind: "kb", kb: "acme" });
    expect(h!.dir("rules")).toBe(path.join(kbRoot("acme"), "projects", "projA", "rules"));
  });
  it("rule 3: a group with no KB → pending-create KB named after the group", () => {
    const h = resolveKnowledgeHome(cfg(), "projD");
    expect(h).toMatchObject({ kind: "pending-create", kb: "loose" });
    expect(h!.dir("rules")).toBe(path.join(kbRoot("loose"), "projects", "projD", "rules"));
  });
  it("rule 3: a KB already registered under the group's name is the home", () => {
    const c = cfg();
    c.knowledgeBases = { loose: { path: "/kbs/loose" } };
    expect(resolveKnowledgeHome(c, "projD")).toMatchObject({ kind: "kb", kb: "loose" });
    expect(homeKb(c, "projD")).toBe("loose");
  });
  it("rule 4: no group → personal, pending-create until knowledgeBases.personal is configured", () => {
    const c = cfg();
    expect(resolveKnowledgeHome(c, "projE")).toMatchObject({ kind: "pending-create", kb: "personal" });
    c.knowledgeBases = { personal: { path: "/kbs/personal" } };
    const h = resolveKnowledgeHome(c, "projE");
    expect(h).toMatchObject({ kind: "kb", kb: "personal" });
    expect(h!.dir("rules")).toBe(path.join("/kbs/personal", "projects", "projE", "rules"));
    expect(homeKb(c, "projE")).toBe("personal");
  });
  it("an unknown project or an unrecognized knowledgeHome → undefined", () => {
    expect(resolveKnowledgeHome(cfg(), "nope")).toBeUndefined();
    expect(resolveKnowledgeHome(cfg(), "projF")).toBeUndefined();
  });
  it("homeAuditKb: home KB, repo:<p>, or '' while the home is pending", () => {
    const c = cfg();
    expect(["projA", "projB", "projC", "projD", "projE", "nope"].map((p) => homeAuditKb(c, p))).toEqual(["acme", "globex", "repo:projC", "", "", ""]);
  });
});

describe("Phase 1 wrappers keep their results", () => {
  const c = cfg();
  it.each([
    ["projA", "acme", path.join(kbRoot("acme"), "projects", "projA", "rules"), ["acme", "initech"]],
    ["projB", "globex", path.join(kbRoot("globex"), "projects", "projB", "rules"), ["acme", "globex"]],
    ["projC", undefined, path.join("/repo/c", "docs", "rules"), ["acme"]],
    ["projD", undefined, undefined, []],
    ["projE", undefined, undefined, []],
    ["projF", undefined, undefined, []],
    ["nope", undefined, undefined, []],
  ])("%s → homeKb %s, projectRulesHome %s, subscribedKbs %j", (p, kb, rules, subs) => {
    expect(homeKb(c, p)).toBe(kb);
    expect(projectRulesHome(c, p)).toBe(rules);
    expect(subscribedKbs(c, p)).toEqual(subs);
  });
});

describe("knowledgeReadSet order", () => {
  const env = { SQUADRANT_USER_KB_DIR: "/u/kb" };
  it("_user/profile → group KB shared → home KB shared → home → each knowledge[] KB's shared", () => {
    const c = cfg();
    c.projects.projB.knowledge = ["initech", "acme"];
    const layers = knowledgeReadSet(c, "projB", env);
    expect(layers.map((l) => l.origin)).toEqual(["_user/profile", "acme/shared", "globex/shared", "globex/projects/projB", "initech/shared"]);
    expect(layers[0]).toMatchObject({ kb: "_user", root: "/u/kb", domains: ["profile"] });
    expect(layers[1]).toMatchObject({ kb: "acme", level: "shared", root: path.join(kbRoot("acme"), "shared") });
    expect(layers[3]).toMatchObject({ kb: "globex", level: "project", project: "projB", root: path.join(kbRoot("globex"), "projects", "projB") });
    expect(layers[1].domains).not.toContain("profile");
  });
  it("group KB as home: shared once, then the project layer", () => {
    expect(knowledgeReadSet(cfg(), "projA", env).map((l) => l.origin)).toEqual(["_user/profile", "acme/shared", "acme/projects/projA", "initech/shared"]);
  });
  it("a repo:docs home is a project layer labeled repo:<p>", () => {
    const layers = knowledgeReadSet(cfg(), "projC", env);
    expect(layers.map((l) => l.origin)).toEqual(["_user/profile", "acme/shared", "repo:projC"]);
    expect(layers[2]).toMatchObject({ kb: "repo:projC", level: "project", root: path.join("/repo/c", "docs") });
  });
  it("a pending-create home contributes nothing", () => {
    const c = cfg();
    c.projects.projD.knowledge = ["initech"];
    expect(knowledgeReadSet(c, "projD", env).map((l) => l.origin)).toEqual(["_user/profile", "initech/shared"]);
    expect(knowledgeReadSet(c, "projE", env).map((l) => l.origin)).toEqual(["_user/profile"]);
  });
  it("an unknown project has no read set", () => {
    expect(knowledgeReadSet(cfg(), "nope", env)).toEqual([]);
  });
});

describe("validateItemDomain (D3 folder vs frontmatter, D4 reserved prefixes)", () => {
  it("D3: a decisions file with domain: wiki fails; a matching or absent domain passes", () => {
    expect(validateItemDomain({ id: "dec.x", domain: "wiki" }, "decisions")).toEqual([expect.stringContaining("D3")]);
    expect(validateItemDomain({ id: "dec.x", domain: "decisions" }, "decisions")).toEqual([]);
    expect(validateItemDomain({ id: "dec.x" }, "decisions")).toEqual([]);
  });
  it("D4: decisions/wiki/profile require their prefix", () => {
    expect(validateItemDomain({ id: "x.y", domain: "decisions" }, "decisions")).toEqual([expect.stringContaining("'dec.'")]);
    expect(validateItemDomain({ id: "dec.y", domain: "wiki" }, "wiki")).toEqual([expect.stringContaining("'wiki.'")]);
    expect(validateItemDomain({ domain: "profile" }, "profile")).toEqual([expect.stringContaining("(missing)")]);
    expect(validateItemDomain({ id: "wiki.y", domain: "wiki" }, "wiki")).toEqual([]);
  });
  it("D4: a rule category or id prefix may not be dec/wiki/prof; category coding passes", () => {
    expect(validateItemDomain({ id: "dec.x", domain: "dec" }, "rules")).toEqual([
      expect.stringContaining("category 'dec' is reserved for the decisions domain"),
      expect.stringContaining("reserved prefix 'dec.'"),
    ]);
    expect(validateItemDomain({ id: "prof.x", domain: "coding" }, "rules")).toEqual([expect.stringContaining("reserved prefix 'prof.'")]);
    expect(validateItemDomain({ id: "coding.x", domain: "coding" }, "rules")).toEqual([]);
  });
});

describe("normalizeSourceRef", () => {
  it.each([
    ["issue:893", "issue:#893"],
    ["Issue:#893", "issue:#893"],
    ["  file:~/x/notes.md#3 ", "file:~/x/notes.md#3"],
    ["SESSION:abc", "session:abc"],
    ["memory: -Users-x-proj/feedback.md#abc123 ", "memory:-Users-x-proj/feedback.md#abc123"],
    ["commit:abc1234", "commit:abc1234"],
    ["raw/handbook.docx", "raw/handbook.docx"],
    ["operator decision in chat 2026-10-26", "operator decision in chat 2026-10-26"],
    ["https://example.com/a", "https://example.com/a"],
  ])("%j → %j", (input, want) => {
    expect(normalizeSourceRef(input)).toBe(want);
  });
  it("a rule's RuleSourceRef object normalizes to its ref", () => {
    expect(normalizeSourceRef({ ref: "raw/a.md", sha: "s", quote: "q" })).toBe("raw/a.md");
  });
});
