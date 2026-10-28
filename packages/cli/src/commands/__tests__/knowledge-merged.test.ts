// #979 2a §4.3: `squadrant knowledge list|search|show`, the merged view over a project's read set.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, saveConfig, type SquadrantConfig } from "@squadrant/shared";
import { serializeTrait } from "@squadrant/core";
import {
  loadMergedView, renderMergedList, runKnowledgeSearch, renderMergedSearch, runKnowledgeShow, formatItem, type MergedOpts,
} from "../knowledge.js";

let dir: string;
let cfgPath: string;
const rule = (id: string, body: string, keywords: string[], status = "active", category = "coding") =>
  `---\nid: ${id}\ndomain: ${category}\nmodality: must\nstatus: ${status}\nsources:\n  - { ref: raw/guide.md, sha: s, quote: q }\n`
  + `triggers:\n  keywords: [${keywords.join(", ")}]\n---\n${body}\n`;
const decision = (id: string, summary: string, keywords: string[]) =>
  `---\nid: ${id}\nstatus: accepted\nsources: ["issue:7"]\ncreated: 2026-10-01\nupdated: 2026-10-01\nsummary: ${summary}\n`
  + `triggers:\n  keywords: [${keywords.join(", ")}]\n---\n# ${summary}\n\nWhy.\n`;
function write(rel: string, text: string) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
const auditDir = () => path.join(dir, "audit");
const opts = (project: string, over: Partial<MergedOpts> = {}): MergedOpts =>
  ({ project, env: { SQUADRANT_USER_KB_DIR: path.join(dir, "user-kb") }, audit: { dir: auditDir(), machineId: "m1" }, ...over });
const events = () => (fs.existsSync(auditDir()) ? fs.readdirSync(auditDir()) : []).flatMap((f) =>
  fs.readFileSync(path.join(auditDir(), f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-kb-merged-"));
  cfgPath = path.join(dir, "config.json");
  const c = getDefaultConfig();
  c.hubVault = path.join(dir, "hub");
  c.knowledgeBases = { acme: { path: path.join(dir, "kb", "acme") }, globex: { path: path.join(dir, "kb", "globex") } };
  c.groups = { acme: { kb: "acme" }, globex: { kb: "globex" } };
  c.projects = {
    projA: { path: path.join(dir, "projA"), captainName: "a", spokeVault: path.join(dir, "spoke"), host: "local", group: "acme" },
    projB: { path: path.join(dir, "projB"), captainName: "b", spokeVault: path.join(dir, "spoke"), host: "local", group: "globex" },
  } as SquadrantConfig["projects"];
  saveConfig(c, cfgPath);
  write("kb/acme/shared/rules/coding/coding.tabs.md", rule("coding.tabs", "Indent with tabs.", ["indent", "tabs"]));
  write("kb/acme/shared/rules/coding/coding.old.md", rule("coding.old", "Indent with two spaces.", ["indent"], "retired"));
  write("kb/acme/shared/rules/pr/pr.small.md", rule("pr.small", "Keep pull requests small.", ["pull", "small"], "active", "pr"));
  write("kb/acme/shared/decisions/dec.acme-db.md", decision("dec.acme-db", "Use Postgres for every service database.", ["postgres", "database"]));
  write("kb/acme/projects/projA/rules/coding/coding.tabs.md", rule("coding.tabs", "Indent with tabs, width 4.", ["indent", "tabs", "width"]));
  write("kb/globex/shared/rules/coding/coding.globex-only.md", rule("coding.globex-only", "Indent with globex spaces.", ["indent", "tabs"]));
  write("kb/globex/shared/decisions/dec.globex-db.md", decision("dec.globex-db", "Globex postgres database cluster.", ["postgres", "database"]));
  fs.mkdirSync(path.join(dir, "user-kb", "profile"), { recursive: true });
  fs.writeFileSync(path.join(dir, "user-kb", "profile", "tabs.md"), serializeTrait({
    id: "prof.tabs", domain: "profile", level: "shared", status: "active", kind: "preference", confirmed: true,
    summary: "Operator likes tabs.", audience: "all", tier: "core", sources: [], created: "2026-10-14", updated: "2026-10-14", body: "b\n",
  }));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("knowledge list", () => {
  it("one line per item with its origin; overridden items labeled; retired hidden", () => {
    expect(renderMergedList(loadMergedView(opts("projA"), cfgPath))).toEqual([
      "[acme/projects/projA] rules coding.tabs: Indent with tabs, width 4.",
      "[acme/shared → overridden by projA] rules coding.tabs: Indent with tabs.",
      "[acme/shared] decisions dec.acme-db: Use Postgres for every service database.",
      "[acme/shared] rules pr.small: Keep pull requests small.",
      "[_user/profile] profile prof.tabs: Operator likes tabs.",
    ]);
  });
  it("--all shows every status, labeled", () => {
    expect(renderMergedList(loadMergedView(opts("projA", { all: true }), cfgPath)))
      .toContain("[acme/shared] rules coding.old: Indent with two spaces. (retired)");
  });
  it("--domain, --level, and a deprecated category value for --domain", () => {
    expect(renderMergedList(loadMergedView(opts("projA", { domain: "decisions" }), cfgPath)))
      .toEqual(["[acme/shared] decisions dec.acme-db: Use Postgres for every service database."]);
    expect(renderMergedList(loadMergedView(opts("projA", { level: "project" }), cfgPath)))
      .toEqual(["[acme/projects/projA] rules coding.tabs: Indent with tabs, width 4."]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadMergedView(opts("projA", { domain: "pr" }), cfgPath).items.map((x) => x.id)).toEqual(["pr.small"]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("--domain pr is a rule category; use --category pr"));
    err.mockRestore();
    expect(() => loadMergedView(opts("projA", { level: "group" }), cfgPath)).toThrow(/--level/);
  });
});

describe("knowledge search", () => {
  it("ranks across domains and logs one item.searched per printed hit with the item's kb/level/domain", () => {
    const hits = runKnowledgeSearch("postgres database", opts("projA"), cfgPath);
    expect(hits[0].rule.id).toBe("dec.acme-db");
    expect(renderMergedSearch(hits, {})[0]).toMatch(/^\[\d+\] \[acme\/shared\] decisions dec\.acme-db: /);
    expect(events()).toMatchObject([{ event: "item.searched", itemId: "dec.acme-db", kb: "acme", level: "shared", domain: "decisions", project: "projA", query: "postgres database" }]);
  });
  it("a project-level item carries its home KB; a rule keeps its category", () => {
    runKnowledgeSearch("tabs width", opts("projA", { domain: "rules" }), cfgPath);
    expect(events()[0]).toMatchObject({ itemId: "coding.tabs", kb: "acme", level: "project", domain: "rules", category: "coding" });
  });
  it("no hits → one unattributed event and an explicit line", () => {
    expect(renderMergedSearch(runKnowledgeSearch("keycloak", opts("projA"), cfgPath), {})).toEqual(["(no matching items)"]);
    expect(events()).toMatchObject([{ event: "item.searched", itemId: "", kb: "acme", query: "keycloak" }]);
  });
});

describe("knowledge show", () => {
  it("prints the item with origin, what it overrides and sources; logs item.shown", () => {
    const { item, overrides } = runKnowledgeShow("coding.tabs", opts("projA"), cfgPath);
    const out = formatItem(item, overrides);
    expect(out).toContain("rules coding.tabs: Indent with tabs, width 4.");
    expect(out).toContain("active · project · acme/projects/projA · coding");
    expect(out).toContain("overrides acme/shared");
    expect(out).toContain("source: raw/guide.md");
    expect(events()).toMatchObject([{ event: "item.shown", itemId: "coding.tabs", kb: "acme", level: "project", domain: "rules" }]);
  });
  it("unknown id throws", () => {
    expect(() => runKnowledgeShow("nope", opts("projA"), cfgPath)).toThrow(/No item 'nope'/);
  });
});

describe("isolation: two company KBs (#979 §8)", () => {
  it("no cross-company item in list, search or show", () => {
    const a = renderMergedList(loadMergedView(opts("projA", { all: true }), cfgPath)).join("\n");
    const b = renderMergedList(loadMergedView(opts("projB", { all: true }), cfgPath)).join("\n");
    expect(a).not.toMatch(/globex/);
    expect(b).toContain("dec.globex-db");
    expect(b).not.toMatch(/acme|coding\.tabs|pr\.small/);
    expect(runKnowledgeSearch("postgres database indent tabs", opts("projA", { limit: 50 }), cfgPath).map((h) => h.rule.id)).not.toContain("dec.globex-db");
    expect(runKnowledgeSearch("postgres database indent tabs", opts("projB", { limit: 50 }), cfgPath).map((h) => h.rule.kb)).not.toContain("acme");
    expect(() => runKnowledgeShow("dec.globex-db", opts("projA"), cfgPath)).toThrow(/No item/);
    expect(() => runKnowledgeShow("dec.acme-db", opts("projB"), cfgPath)).toThrow(/No item/);
    expect(events().filter((e) => e.project === "projA").every((e) => e.kb === "acme")).toBe(true);
    expect(events().filter((e) => e.project === "projB").every((e) => e.kb === "globex")).toBe(true);
  });
});
