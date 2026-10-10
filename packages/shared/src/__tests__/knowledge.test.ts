import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  validateRuleFrontmatter, validateSourceEntry, subscribedKbs, resolveKbConfig,
  DEFAULT_DOMAIN_CAP, getDefaultConfig, kbPath, kbConfigs, projectRulesHome,
} from "../index.js";
import type { SquadrantConfig } from "../index.js";

const good = {
  id: "biz.invoice.vnd-rounding", domain: "business", modality: "must", status: "active",
  triggers: { keywords: ["invoice"], when: "Computing VND amounts" },
  sources: [{ ref: "raw/p.pdf", sha: "9f2c", loc: "p.12", offset: [10, 40], quote: "All VND amounts shall be rounded half-up." }],
};

describe("validateRuleFrontmatter", () => {
  it("accepts a well-formed rule", () => {
    expect(validateRuleFrontmatter(good)).toEqual([]);
  });
  it("rejects a bad id, modality, status and empty sources", () => {
    const problems = validateRuleFrontmatter({ ...good, id: "Bad Id", modality: "maybe", status: "live", sources: [] });
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining("id"), expect.stringContaining("modality"),
      expect.stringContaining("status"), expect.stringContaining("sources"),
    ]));
  });
  it("rejects a source without a quote and a malformed offset", () => {
    const problems = validateRuleFrontmatter({ ...good, sources: [{ ref: "r", sha: "s", offset: [1] }] });
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining("quote"), expect.stringContaining("offset"),
    ]));
  });
  it("rejects non-object input", () => {
    expect(validateRuleFrontmatter(null)).toEqual(["frontmatter must be an object"]);
  });
});

describe("validateSourceEntry", () => {
  it("accepts path+priority and optional fields", () => {
    expect(validateSourceEntry({ path: "raw/**", priority: "company", domain: "coding", sensitivity: "local-only" })).toEqual([]);
  });
  it("rejects missing path and unknown priority/sensitivity", () => {
    const p = validateSourceEntry({ priority: "boss", sensitivity: "secret" });
    expect(p).toEqual(expect.arrayContaining([
      expect.stringContaining("path"), expect.stringContaining("priority"), expect.stringContaining("sensitivity"),
    ]));
  });
});

describe("subscription + kb config", () => {
  function cfg(): SquadrantConfig {
    const c = getDefaultConfig();
    c.projects = {
      alpha: { path: "/a", captainName: "a", spokeVault: "/v/a", host: "local" },
      flooros: { path: "/f", captainName: "f", spokeVault: "/v/f", host: "local", knowledge: ["saitex"] },
      core: { path: "/c", captainName: "c", spokeVault: "/v/c", host: "local", knowledge: ["saitex", "x"] },
    };
    return c;
  }
  it("subscribedKbs returns the project's list or []", () => {
    expect(subscribedKbs(cfg(), "core")).toEqual(["saitex", "x"]);
    expect(subscribedKbs(cfg(), "alpha")).toEqual([]);
  });
  it("homeProject defaults to the first subscriber; domainCap defaults to 150", () => {
    expect(resolveKbConfig(cfg(), "saitex")).toEqual({ homeProject: "flooros", domainCap: DEFAULT_DOMAIN_CAP });
  });
  it("explicit kb config wins", () => {
    const c = cfg();
    c.knowledge = { saitex: { homeProject: "core", domainCap: 20 } };
    expect(resolveKbConfig(c, "saitex")).toEqual({ homeProject: "core", domainCap: 20 });
  });
  it("homeProject is undefined when nobody subscribes", () => {
    expect(resolveKbConfig(cfg(), "nobody").homeProject).toBeUndefined();
  });
});

describe("group inheritance + KB config (#936)", () => {
  function cfg(): SquadrantConfig {
    const c = getDefaultConfig();
    c.groups = { saitex: { kb: "saitex" }, loose: {} };
    c.projects = {
      flooros: { path: "/f", captainName: "f", spokeVault: "/v/f", host: "local", group: "saitex", knowledge: ["conv"] },
      lone: { path: "/l", captainName: "l", spokeVault: "/v/l", host: "local", group: "loose" },
      docs: { path: "/d", captainName: "d", spokeVault: "/v/d", host: "local", group: "saitex", knowledgeHome: "repo:docs" },
    };
    return c;
  }
  it("subscribedKbs: group KB first, then knowledge[]", () => {
    expect(subscribedKbs(cfg(), "flooros")).toEqual(["saitex", "conv"]);
    expect(subscribedKbs(cfg(), "lone")).toEqual([]);
  });
  it("kbPath defaults to ~/squadrant/kb/<kb>; path overrides; deprecated knowledge alias is read", () => {
    const c = cfg();
    expect(kbPath(c, "saitex")).toBe(path.join(os.homedir(), "squadrant", "kb", "saitex"));
    c.knowledge = { a: { path: "/old/a", domainCap: 5 } };
    c.knowledgeBases = { a: { domainCap: 9 }, b: { path: "/new/b" } };
    expect(kbPath(c, "a")).toBe("/old/a");
    expect(kbConfigs(c).a).toEqual({ path: "/old/a", domainCap: 9 });
    expect(kbPath(c, "b")).toBe("/new/b");
  });
  it("projectRulesHome: <kb>/projects/<p>/rules, docs/rules for repo:docs, none without a home", () => {
    const c = cfg();
    expect(projectRulesHome(c, "flooros")).toBe(path.join(os.homedir(), "squadrant", "kb", "saitex", "projects", "flooros", "rules"));
    expect(projectRulesHome(c, "docs")).toBe(path.join("/d", "docs", "rules"));
    expect(projectRulesHome(c, "lone")).toBeUndefined();
  });
});
