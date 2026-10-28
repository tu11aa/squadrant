// KB phase 2 (#979) shared read side: loaders, merged read set, D3/D4 item validation. Synthetic fixtures only.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import { kbLayers, listItemFiles, loadKbItems, loadLayerDomain, resolveReadSet, validateKbItems } from "../knowledge/index.js";

let tmp: string;
let cfg: SquadrantConfig;
let env: NodeJS.ProcessEnv;
const put = (rel: string, text: string) => {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};
const rule = (id: string, category: string, statement = `Statement of ${id}.`) =>
  `---\nid: ${id}\ndomain: ${category}\nmodality: must\nstatus: active\nsources:\n  - { ref: raw/a.md, sha: s, quote: q }\n---\n${statement}\n\nWhy it matters.\n`;
// The live decision record shape (frontmatter + `# Title`, `## Context`, `## Decision`).
const decision = (slug: string, title: string, over = "") => `---
id: dec.${slug}
domain: decisions
level: shared
status: accepted
decidedBy: operator
decidedAt: 2026-10-08
sources:
  - "file:~/x/notes.md#3"
  - "session:abc"
  - "operator decision in chat 2026-10-26"
created: 2026-10-08
updated: 2026-10-09
${over}---
# ${title}

## Context

Why this came up.

## Decision

What was decided.
`;
// The live trait shape (profile.ts Trait).
const TRAIT = `---
id: prof.early-ui-one-branch
domain: profile
level: shared
status: active
kind: preference
confirmed: true
summary: Early UI screens go on one tmp branch
audience: all
tier: core
triggers:
  keywords: [ui, branch]
sources:
  - "memory:-Users-x-projA/feedback.md#abc123def456"
  - "Session:s1"
created: 2026-10-15
updated: 2026-10-16
---
Put early UI screens on one tmp branch until the layout settles.
`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-items-"));
  cfg = getDefaultConfig();
  cfg.knowledgeBases = { acme: { path: path.join(tmp, "kb", "acme") }, globex: { path: path.join(tmp, "kb", "globex") } };
  cfg.groups = { acme: { kb: "acme" } };
  cfg.projects = {
    projA: { path: "/repo/a", captainName: "a", spokeVault: "/v", host: "local", group: "acme", knowledge: ["globex"], rulesDisabled: ["pr.small", "pr.nope"] },
    projB: { path: "/repo/b", captainName: "b", spokeVault: "/v", host: "local", group: "acme" },
  };
  env = { SQUADRANT_USER_KB_DIR: path.join(tmp, "user") };
  put("kb/acme/shared/rules/coding/coding.result.md", rule("coding.result", "coding"));
  put("kb/acme/shared/rules/pr/pr.small.md", rule("pr.small", "pr"));
  put("kb/acme/shared/rules/_proposed/coding.pending.md", rule("coding.pending", "coding"));
  put("kb/acme/shared/rules/_archive/coding.old.md", rule("coding.old", "coding"));
  put("kb/acme/shared/decisions/dec.use-postgres.md", decision("use-postgres", "Use Postgres for the order store"));
  put("kb/acme/shared/decisions/dec.monorepo.md", decision("monorepo", "One monorepo for all services"));
  put("kb/acme/shared/decisions/dec.release-train.md", decision("release-train", "Weekly release train"));
  put("kb/acme/shared/decisions/_proposed/dec.pending.md", decision("pending", "Pending"));
  put("kb/acme/projects/projA/rules/coding.result.md", rule("coding.result", "coding", "Project override."));
  put("kb/globex/shared/rules/coding/coding.globex-only.md", rule("coding.globex-only", "coding"));
  put("kb/globex/shared/rules/coding/pr.small.md", rule("pr.small", "pr", "Globex copy."));
  put("user/profile/early-ui-one-branch.md", TRAIT);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const acmeShared = () => kbLayers(cfg, "acme", env)[0];

describe("loaders", () => {
  it("listItemFiles recurses and skips _proposed/ and _archive/", () => {
    const rel = listItemFiles(path.join(tmp, "kb/acme/shared/rules")).map((f) => path.relative(tmp, f));
    expect(rel).toEqual(["kb/acme/shared/rules/coding/coding.result.md", "kb/acme/shared/rules/pr/pr.small.md"]);
  });
  it("rules recurse category folders, skip _proposed/ and _archive/, and keep their category", () => {
    const res = loadLayerDomain(acmeShared(), "rules");
    expect(res.errors).toEqual([]);
    expect(res.items.map((i) => i.id).sort()).toEqual(["coding.result", "pr.small"]);
    expect(res.items.find((i) => i.id === "pr.small")).toMatchObject({
      kbDomain: "rules", kb: "acme", level: "shared", origin: "acme/shared", category: "pr", status: "active",
      summary: "Statement of pr.small.", sources: ["raw/a.md"],
    });
  });
  it("loads decision records in the live shape; the summary is the # title", () => {
    const res = loadLayerDomain(acmeShared(), "decisions");
    expect(res.errors).toEqual([]);
    expect(res.items.map((i) => [i.id, i.summary])).toEqual([
      ["dec.monorepo", "One monorepo for all services"],
      ["dec.release-train", "Weekly release train"],
      ["dec.use-postgres", "Use Postgres for the order store"],
    ]);
    expect(res.items[0]).toMatchObject({
      kbDomain: "decisions", kb: "acme", level: "shared", status: "accepted", created: "2026-10-08", updated: "2026-10-09", origin: "acme/shared",
      sources: ["file:~/x/notes.md#3", "session:abc", "operator decision in chat 2026-10-26"],
    });
    expect(res.items[0].body).toMatch(/^# One monorepo for all services\n\n## Context[\s\S]*## Decision/);
  });
  it("a trait in the live profile shape loads as a profile KbItem", () => {
    const [layer] = kbLayers(cfg, "_user", env);
    const res = loadLayerDomain(layer, "profile");
    expect(res.errors).toEqual([]);
    expect(res.items).toEqual([expect.objectContaining({
      id: "prof.early-ui-one-branch", kbDomain: "profile", kb: "_user", level: "shared", status: "active", origin: "_user/profile",
      summary: "Early UI screens go on one tmp branch", triggers: { keywords: ["ui", "branch"] }, created: "2026-10-15", updated: "2026-10-16",
      sources: ["memory:-Users-x-projA/feedback.md#abc123def456", "session:s1"],
      path: path.join(tmp, "user", "profile", "early-ui-one-branch.md"),
    })]);
  });
  it("a layer only loads the domains it can hold", () => {
    expect(loadLayerDomain(acmeShared(), "profile").items).toEqual([]);
    expect(loadLayerDomain(kbLayers(cfg, "_user", env)[0], "rules").items).toEqual([]);
  });
  it("loadKbItems covers every level and domain of one KB", () => {
    const res = loadKbItems(cfg, "acme", env);
    expect(res.errors).toEqual([]);
    expect(res.items.map((i) => `${i.origin}:${i.id}`).sort()).toEqual([
      "acme/projects/projA:coding.result", "acme/shared:coding.result", "acme/shared:dec.monorepo",
      "acme/shared:dec.release-train", "acme/shared:dec.use-postgres", "acme/shared:pr.small",
    ]);
  });
});

describe("resolveReadSet", () => {
  it("merges the read set: project overrides are labeled, rulesDisabled hides rules, later shared copies are shadowed", () => {
    const res = resolveReadSet(cfg, "projA", { env });
    expect(res.layers.map((l) => l.origin)).toEqual(["_user/profile", "acme/shared", "acme/projects/projA", "globex/shared"]);
    expect(res.items.map((i) => `${i.id}@${i.origin}`)).toEqual([
      "coding.globex-only@globex/shared", "coding.result@acme/projects/projA", "dec.monorepo@acme/shared",
      "dec.release-train@acme/shared", "dec.use-postgres@acme/shared", "prof.early-ui-one-branch@_user/profile",
    ]);
    expect(res.overridden).toEqual([{
      item: expect.objectContaining({ id: "coding.result", origin: "acme/shared" }),
      by: expect.objectContaining({ id: "coding.result", origin: "acme/projects/projA", summary: "Project override." }),
    }]);
    expect(res.warnings).toEqual(expect.arrayContaining([
      "item 'pr.small' in globex/shared shadowed by acme/shared",
      "rulesDisabled: unknown rule id 'pr.nope'",
    ]));
    expect(res.errors).toEqual([]);
  });
  it("a domain filter limits what is loaded; rulesDisabled is skipped without rules", () => {
    const res = resolveReadSet(cfg, "projA", { env, domains: ["decisions"] });
    expect(res.items.map((i) => i.id)).toEqual(["dec.monorepo", "dec.release-train", "dec.use-postgres"]);
    expect(res.warnings).toEqual([]);
  });
  it("throws for an unknown project", () => {
    expect(() => resolveReadSet(cfg, "nope", { env })).toThrow(/Unknown project/);
  });
});

describe("validateKbItems (D3/D4 + common fields, incl. _proposed/)", () => {
  const problems = () => Object.fromEntries(validateKbItems(cfg, "acme", env).map((e) => [path.relative(tmp, e.file), e.problems]));
  it("a clean KB has no problems", () => {
    expect(problems()).toEqual({});
  });
  it("flags D3 (decisions file with domain: wiki), D4 (missing dec., reserved rule category/id), and bad common fields", () => {
    put("kb/acme/shared/decisions/dec.wrong-folder.md", decision("wrong-folder", "W").replace("domain: decisions", "domain: wiki"));
    put("kb/acme/shared/decisions/no-prefix.md", decision("x", "N").replace("id: dec.x", "id: plain.x"));
    put("kb/acme/shared/decisions/_proposed/dec.bad-date.md", decision("bad-date", "B").replace("created: 2026-10-08", "created: soon"));
    put("kb/acme/shared/rules/dec/dec.cat.md", rule("dec.cat", "dec"));
    put("kb/acme/projects/projA/rules/prof.x.md", rule("prof.x", "coding"));
    put("kb/acme/shared/rules/coding/coding.fine.md", rule("coding.fine", "coding"));
    const p = problems();
    expect(Object.keys(p).sort()).toEqual([
      "kb/acme/projects/projA/rules/prof.x.md", "kb/acme/shared/decisions/_proposed/dec.bad-date.md",
      "kb/acme/shared/decisions/dec.wrong-folder.md", "kb/acme/shared/decisions/no-prefix.md", "kb/acme/shared/rules/dec/dec.cat.md",
    ]);
    expect(p["kb/acme/shared/decisions/dec.wrong-folder.md"]).toEqual([expect.stringContaining("(D3)")]);
    expect(p["kb/acme/shared/decisions/no-prefix.md"]).toEqual([expect.stringContaining("must start with 'dec.'")]);
    expect(p["kb/acme/shared/decisions/_proposed/dec.bad-date.md"]).toEqual(["created must be a YYYY-MM-DD date"]);
    expect(p["kb/acme/shared/rules/dec/dec.cat.md"]).toEqual([expect.stringContaining("category 'dec' is reserved"), expect.stringContaining("reserved prefix 'dec.'")]);
    expect(p["kb/acme/projects/projA/rules/prof.x.md"]).toEqual([expect.stringContaining("reserved prefix 'prof.'")]);
  });
  it("a decision with malformed triggers is rejected at load, so search never sees it", () => {
    put("kb/acme/shared/decisions/dec.bad-triggers.md", decision("bad-triggers", "B", "triggers:\n  keywords: postgres\n"));
    const res = loadLayerDomain(acmeShared(), "decisions");
    expect(res.items.map((i) => i.id)).not.toContain("dec.bad-triggers");
    expect(res.errors).toEqual([expect.objectContaining({ problems: ["triggers.keywords must be a string array"] })]);
  });
  it("the loader rejects what validation flags, so a D3 decision never goes live", () => {
    put("kb/acme/shared/decisions/dec.wrong-folder.md", decision("wrong-folder", "W").replace("domain: decisions", "domain: wiki"));
    const res = loadLayerDomain(acmeShared(), "decisions");
    expect(res.items.map((i) => i.id)).not.toContain("dec.wrong-folder");
    expect(res.errors).toEqual([expect.objectContaining({ file: expect.stringContaining("dec.wrong-folder.md") })]);
  });
});
