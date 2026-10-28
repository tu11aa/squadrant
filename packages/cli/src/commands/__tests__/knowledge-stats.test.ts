// `knowledge stats` over every KB, `_user`, `repo:<p>` homes and the (no home) group (#979 §4.6, C4).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, saveConfig } from "@squadrant/shared";
import { serializeTrait, type Trait } from "@squadrant/core";
import { runKnowledgeStats, renderStats, NO_HOME_LABEL, type StatsOpts } from "../knowledge.js";

const NOW = new Date("2026-10-10T00:00:00Z");
let dir: string;
let cfgPath: string;
let auditDir: string;
let userKb: string;

const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const rule = (id: string, category = "coding") =>
  `---\nid: ${id}\ndomain: ${category}\nmodality: must\nstatus: active\nsources:\n  - { ref: raw/a.md, sha: s, loc: "L1", quote: q }\n---\nDo ${id}.\n`;
const trait = (id: string) => serializeTrait({ id, domain: "profile", level: "shared", status: "active", kind: "preference", confirmed: true, summary: `Summary ${id}.`,
  audience: "all", tier: "core", sources: [], created: "2026-10-01", updated: "2026-10-01", body: "b\n" } as Trait);
const ev = (kb: string, project: string, itemId: string, domain = "rules", extra: Record<string, unknown> = {}) =>
  ({ ts: "2026-10-05T00:00:00Z", kb, level: "shared", project, domain, itemId, event: "item.surfaced", ...extra });
const stats = (o: StatsOpts = {}) => runKnowledgeStats({ auditDir, now: NOW, env: { SQUADRANT_USER_KB_DIR: userKb }, ...o }, cfgPath);
const ids = (kb: string, all = stats()) => all.find((s) => s.kb === kb)!.items.map((x) => x.itemId);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-stats-"));
  cfgPath = path.join(dir, "config.json");
  auditDir = path.join(dir, "audit");
  userKb = path.join(dir, "kb", "_user");
  const p = (name: string, extra: Record<string, unknown> = {}) => ({ path: path.join(dir, "repos", name), captainName: name, spokeVault: path.join(dir, "spoke"), host: "local", ...extra }) as never;
  const c = getDefaultConfig();
  c.hubVault = path.join(dir, "hub");
  c.knowledgeBases = { acme: { path: path.join(dir, "kb", "acme") }, globex: { path: path.join(dir, "kb", "globex") } };
  c.groups = { ga: { kb: "acme" }, gb: { kb: "globex" }, gn: {} };
  c.projects = { projA: p("projA", { group: "ga" }), projB: p("projB", { group: "gb" }), projR: p("projR", { knowledgeHome: "repo:docs" }), projN: p("projN", { group: "gn" }) };
  saveConfig(c, cfgPath);
  write(path.join(dir, "kb", "acme", "shared", "rules", "coding", "coding.a.md"), rule("coding.a"));
  write(path.join(dir, "kb", "acme", "shared", "rules", "authz", "authz.a.md"), rule("authz.a", "authz"));
  write(path.join(dir, "kb", "globex", "shared", "rules", "coding", "coding.g.md"), rule("coding.g"));
  write(path.join(dir, "repos", "projR", "docs", "rules", "coding", "coding.r.md"), rule("coding.r"));
  write(path.join(userKb, "profile", "terse.md"), trait("prof.terse"));
  write(path.join(auditDir, "2026-10.m1.jsonl"), [
    ev("acme", "projA", "coding.a", "coding", { level: "group" }),  // legacy: category in domain
    ev("globex", "projB", "coding.g"),
    ev("_user", "projA", "prof.terse", "profile"),
    ev("", "projR", "coding.r", "coding", { level: "project" }),
    ev("", "projN", "coding.n", "rules", { level: "project" }),
    ev("t", "", "coding.a", "coding", { level: "group" }),
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("knowledge stats (#979)", () => {
  it("no args: every KB, _user, each repo:<p> home and the (no home) group", () => {
    const all = stats();
    expect(all.map((s) => s.kb)).toEqual(["acme", "globex", "_user", "repo:projR", NO_HOME_LABEL]);
    expect(ids("_user", all)).toEqual(["prof.terse"]);
    expect(ids("repo:projR", all)).toEqual(["coding.r"]);
    expect(ids(NO_HOME_LABEL, all)).toEqual(["coding.n"]);
    expect(all.find((s) => s.kb === "acme")!.items.find((x) => x.itemId === "coding.a")).toMatchObject({ surfaced: 1, category: "coding" });  // kb:"t" not counted
  });
  it("no (no home) group when no event lacks a home", () => {
    fs.writeFileSync(path.join(auditDir, "2026-10.m1.jsonl"), JSON.stringify(ev("acme", "projA", "coding.a")) + "\n");
    expect(stats().map((s) => s.kb)).not.toContain(NO_HOME_LABEL);
  });
  it("isolation: one company KB never shows another's items or events", () => {
    const all = stats();
    expect(ids("acme", all).sort()).toEqual(["authz.a", "coding.a"]);
    expect(ids("globex", all)).toEqual(["coding.g"]);
    expect(stats({ kb: "acme" })[0].items.map((x) => x.itemId)).not.toContain("coding.g");
  });
  it("--project shows only the KBs of that project's read set", () => {
    expect(stats({ project: "projA" }).map((s) => s.kb)).toEqual(["acme", "_user"]);
    expect(stats({ project: "projR" }).map((s) => s.kb)).toEqual(["repo:projR", "_user"]);
  });
  it("--domain profile shows _user's profile scores only", () => {
    const all = stats({ domain: "profile" });
    expect(all.map((s) => s.kb)).toEqual(["_user"]);
    expect(all[0].domains.map((d) => d.domain)).toEqual(["profile"]);
    expect(all[0].items.map((x) => x.itemId)).toEqual(["prof.terse"]);
  });
  it("--kb _user is accepted; --category (and the deprecated --domain <category>) filter rules by category", () => {
    expect(stats({ kb: "_user" })[0].items.map((x) => x.itemId)).toEqual(["prof.terse"]);
    expect(stats({ kb: "acme", category: "authz" })[0].items.map((x) => x.itemId)).toEqual(["authz.a"]);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(stats({ kb: "acme", domain: "coding" })[0].items.map((x) => x.itemId)).toEqual(["coding.a"]);
    expect(warn.mock.calls[0][0]).toMatch(/--category coding/);
    warn.mockRestore();
    expect(() => stats({ kb: "Bad Name" })).toThrow(/Invalid knowledge base name/);
  });
  it("text render groups by KB, then domain, and flags dead domains", () => {
    const text = renderStats(stats({ kb: "acme" }));
    expect(text.slice(0, 2)).toEqual(["acme (last 30 days)", "  decisions: writes 0/mo  reads 0/mo  DEAD DOMAIN"]);
    const rules = text.indexOf("  rules: writes 0/mo  reads 1/mo");
    expect(rules).toBeGreaterThan(0);
    expect(text[rules + 1]).toMatch(/^ {4}authz\.a {2}surfaced 0 .*NEVER FIRED$/);
    expect(text).toContain("  wiki: writes 0/mo  reads 0/mo  DEAD DOMAIN");
  });
});
