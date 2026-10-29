import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig } from "@squadrant/shared";
import { readIndex } from "@squadrant/core";
import { knowledgeDoctorLines, knowledgeHomeDoctorLines, workspaceDoctorLines } from "../doctor.js";

let hub: string;
const savedCache = process.env.SQUADRANT_INDEX_CACHE_DIR;
beforeEach(() => { hub = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-kb-")); process.env.SQUADRANT_INDEX_CACHE_DIR = path.join(hub, "cache"); });
afterEach(() => { process.env.SQUADRANT_INDEX_CACHE_DIR = savedCache; fs.rmSync(hub, { recursive: true, force: true }); });

describe("knowledgeDoctorLines", () => {
  it("emits nothing when no KB is configured (no new FAILs, cf. #876)", () => {
    expect(knowledgeDoctorLines(getDefaultConfig(), () => false)).toEqual([]);
  });
  it("rebuilds a missing index cache (K8) and flags a missing markitdown (warn only)", () => {
    const c = getDefaultConfig();
    c.hubVault = hub;
    c.knowledgeBases = { saitex: { path: path.join(hub, "kb", "saitex") } };
    fs.mkdirSync(path.join(hub, "kb", "saitex"), { recursive: true });
    const lines = knowledgeDoctorLines(c, () => false);
    expect(lines).toEqual([
      expect.objectContaining({ label: "markitdown installed (rules KB conversion)", ok: false, warnOnly: true }),
      expect.objectContaining({ label: "KB 'saitex' index cache rebuilt (index cache missing for kb 'saitex')", ok: true }),
    ]);
    expect(readIndex("saitex").index?.kb).toBe("saitex");
    expect(fs.existsSync(path.join(hub, "kb", "saitex", "index.json"))).toBe(false);
    expect(knowledgeDoctorLines(c, () => true)).toContainEqual(expect.objectContaining({ label: "KB 'saitex' index cache valid", ok: true }));
  });
  it("rebuilds the index after rm -rf of the cache dir; rebuilds a corrupt one", () => {
    const c = getDefaultConfig();
    c.knowledgeBases = { acme: { path: path.join(hub, "kb", "acme") } };
    fs.mkdirSync(path.join(hub, "kb", "acme", "shared", "rules"), { recursive: true });
    fs.writeFileSync(path.join(hub, "kb", "acme", "shared", "rules", "coding.a.md"),
      "---\nid: coding.a\ndomain: coding\nmodality: must\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n---\nUse Result.\n");
    knowledgeDoctorLines(c, () => true);
    fs.rmSync(path.join(hub, "cache"), { recursive: true, force: true });
    expect(knowledgeDoctorLines(c, () => true)).toContainEqual(expect.objectContaining({ label: expect.stringContaining("KB 'acme' index cache rebuilt"), ok: true }));
    expect(readIndex("acme").index?.rules.map((r) => r.id)).toEqual(["coding.a"]);
    fs.writeFileSync(path.join(hub, "cache", "acme.json"), "{not json");
    expect(knowledgeDoctorLines(c, () => true)).toContainEqual(expect.objectContaining({ label: expect.stringContaining("corrupt"), ok: true }));
    expect(readIndex("acme").problem).toBeUndefined();
  });
  it("fails a configured KB that is not on disk, and hints at a leftover index.json (warn only)", () => {
    const c = getDefaultConfig();
    c.knowledgeBases = { acme: { path: path.join(hub, "kb", "acme") }, globex: { path: path.join(hub, "kb", "globex") } };
    fs.mkdirSync(path.join(hub, "kb", "acme"), { recursive: true });
    fs.writeFileSync(path.join(hub, "kb", "acme", "index.json"), "{}");
    const lines = knowledgeDoctorLines(c, () => true);
    expect(lines).toContainEqual(expect.objectContaining({ label: "KB 'acme' still has index.json (no longer used; the index is a cache now)", ok: false, warnOnly: true }));
    expect(lines).toContainEqual(expect.objectContaining({ label: "KB 'globex' exists", ok: false, hint: expect.stringContaining("squadrant knowledge init globex") }));
    expect(fs.existsSync(path.join(hub, "cache", "globex.json"))).toBe(false);
  });
  it("warns about a KB still under <hubVault>/knowledge/", () => {
    const c = getDefaultConfig();
    c.hubVault = hub;
    fs.mkdirSync(path.join(hub, "knowledge", "saitex"), { recursive: true });
    expect(knowledgeDoctorLines(c, () => true)).toContainEqual(
      expect.objectContaining({ label: expect.stringContaining("saitex"), ok: false, warnOnly: true }));
  });
  it("warns about a leftover <spokeVault>/knowledge/rules overlay", () => {
    const c = getDefaultConfig();
    const spoke = path.join(hub, "spoke");
    fs.mkdirSync(path.join(spoke, "knowledge", "rules"), { recursive: true });
    c.projects = { flooros: { path: "/f", captainName: "f", spokeVault: spoke, host: "local" } };
    expect(knowledgeDoctorLines(c, () => true)).toContainEqual(
      expect.objectContaining({ label: expect.stringContaining("flooros"), ok: false, warnOnly: true }));
  });
});

describe("knowledgeHomeDoctorLines (D5)", () => {
  const repo = (name: string, files: string[]) => {
    const p = path.join(hub, name);
    fs.mkdirSync(path.join(p, "docs"), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(p, f), "x");
    return p;
  };
  it("suggests repo:docs for an open-source-looking project with no group and no knowledgeHome; never writes config", () => {
    const c = getDefaultConfig();
    c.projects = {
      projA: { path: repo("projA", ["LICENSE"]), captainName: "a", spokeVault: "/v", host: "local" },
      projB: { path: repo("projB", []), captainName: "b", spokeVault: "/v", host: "local" },
      projC: { path: repo("projC", ["LICENSE.md"]), captainName: "c", spokeVault: "/v", host: "local", group: "acme" },
      projD: { path: repo("projD", ["LICENSE"]), captainName: "d", spokeVault: "/v", host: "local", knowledgeHome: "kb:acme" },
      projE: { path: path.join(hub, "missing"), captainName: "e", spokeVault: "/v", host: "local" },
    };
    const before = JSON.stringify(c);
    const lines = knowledgeHomeDoctorLines(c);
    expect(lines).toEqual([{
      label: "project 'projA' has no knowledge home and would use the 'personal' KB",
      hint: expect.stringContaining('{ "projects": { "projA": { "knowledgeHome": "repo:docs" } } }'),
    }]);
    expect(JSON.stringify(c)).toBe(before);
  });
});

describe("workspaceDoctorLines (#983)", () => {
  const saved = process.env.SQUADRANT_WORKSPACE_DIR;
  beforeEach(() => { process.env.SQUADRANT_WORKSPACE_DIR = path.join(hub, "ws"); });
  afterEach(() => { process.env.SQUADRANT_WORKSPACE_DIR = saved; });
  const project = (spoke: string) => ({ flooros: { path: "/f", captainName: "f", spokeVault: spoke, host: "local" } });

  it("warns about unmigrated spoke exchange and a missing workspace dir", () => {
    const c = getDefaultConfig();
    c.hubVault = hub;
    const spoke = path.join(hub, "spokes", "flooros");
    fs.mkdirSync(path.join(spoke, "handoffs"), { recursive: true });
    fs.writeFileSync(path.join(spoke, "handoffs", "2026-10-01.json"), "{}");
    c.projects = project(spoke);
    const lines = workspaceDoctorLines(c);
    expect(lines).toContainEqual(expect.objectContaining({ label: expect.stringContaining("not yet migrated"), ok: false, warnOnly: true, hint: expect.stringContaining("squadrant migrate kb") }));
    expect(lines).toContainEqual(expect.objectContaining({ label: "workspace dir for 'flooros' missing", ok: false, warnOnly: true }));
  });

  it("is quiet on a migrated home", () => {
    const c = getDefaultConfig();
    c.hubVault = hub;
    c.projects = project(path.join(hub, "spokes", "flooros"));
    fs.mkdirSync(path.join(hub, "ws", "flooros"), { recursive: true });
    const lines = workspaceDoctorLines(c);
    expect(lines.filter((l) => !l.ok)).toEqual([]);
    expect(lines).toContainEqual(expect.objectContaining({ label: "workspace dir for 'flooros' exists", ok: true }));
  });
});
