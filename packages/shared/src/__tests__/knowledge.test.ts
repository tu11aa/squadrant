import { describe, it, expect } from "vitest";
import {
  validateRuleFrontmatter, validateSourceEntry, subscribedKbs, resolveKbConfig,
  DEFAULT_DOMAIN_CAP, getDefaultConfig,
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
