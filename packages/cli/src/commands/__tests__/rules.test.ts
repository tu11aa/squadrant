import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, saveConfig, loadConfig } from "@squadrant/shared";
import { kbRulesDir } from "@squadrant/core";
import { runRulesMatch, runRulesSearch, runRulesShow, runRulesList, resolveRulesProject, formatRule, renderSearch, renderList, parseLimit } from "../rules.js";
import { runKnowledgeFeedback, runKnowledgeStats, runKnowledgeCiteScan, renderStats, runKnowledgeSurfaced, renderSurfaced } from "../knowledge.js";
import type { SearchHit } from "@squadrant/core";

let dir: string;
let cfgPath: string;
const rule = (id: string, status = "active", extra = "") =>
  `---\nid: ${id}\ndomain: business\nmodality: must\nstatus: ${status}\n${extra}sources:\n  - { ref: raw/Policy-v3.pdf, sha: s, loc: "p.12", quote: q }\n---\nVND amounts are rounded half-up.\n`;

const baseAuditDir = process.env.SQUADRANT_AUDIT_DIR; // hermetic dir from test/setup-env.ts
beforeEach(() => {
  process.env.SQUADRANT_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "audit-rules-"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-rules-"));
  cfgPath = path.join(dir, "config.json");
  const c = getDefaultConfig();
  c.hubVault = path.join(dir, "hub");
  c.knowledgeBases = { saitex: { path: path.join(dir, "kb", "saitex") } };
  c.projects = { flooros: { path: path.join(dir, "flooros"), captainName: "f", spokeVault: path.join(dir, "spoke"), host: "local", knowledge: ["saitex"] } };
  saveConfig(c, cfgPath);
  const rd = path.join(kbRulesDir(c, "saitex"), "business");
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, "biz.invoice.vnd-rounding.md"), rule("biz.invoice.vnd-rounding", "active", "triggers:\n  keywords: [invoice]\n"));
  fs.writeFileSync(path.join(rd, "biz.old.md"), rule("biz.old", "retired", "triggers:\n  keywords: [invoice]\n"));
});
afterEach(() => {
  fs.rmSync(process.env.SQUADRANT_AUDIT_DIR!, { recursive: true, force: true });
  if (baseAuditDir === undefined) delete process.env.SQUADRANT_AUDIT_DIR; else process.env.SQUADRANT_AUDIT_DIR = baseAuditDir;
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
    const rd = path.join(kbRulesDir(loadConfig(cfgPath), "saitex"), "business");
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
  it("search logs one attributed item.searched per displayed hit, so stats count it as a pull", () => {
    runRulesSearch("invoice vnd", { project: "flooros" }, cfgPath);
    expect(read()).toMatchObject([{ event: "item.searched", itemId: "biz.invoice.vnd-rounding", kb: "saitex", level: "group", project: "flooros", query: "invoice vnd" }]);
    const [s] = runKnowledgeStats({ kb: "saitex", auditDir: process.env.SQUADRANT_AUDIT_DIR }, cfgPath);
    expect(s.items.find((x) => x.itemId === "biz.invoice.vnd-rounding")).toMatchObject({ searched: 1, pullRate: 1 });
  });
  it("a search with no hits still logs one unattributed item.searched", () => {
    runRulesSearch("approver role keycloak", { project: "flooros" }, cfgPath);
    expect(read()).toMatchObject([{ event: "item.searched", itemId: "", query: "approver role keycloak" }]);
  });
  it("show logs item.shown", () => {
    runRulesShow("biz.invoice.vnd-rounding", { project: "flooros" }, cfgPath);
    expect(read()[0]).toMatchObject({ event: "item.shown", itemId: "biz.invoice.vnd-rounding", kb: "saitex", level: "group" });
  });
});

describe("rules match", () => {
  const o = { project: "flooros", env: {}, stateRoot: "" };
  it("prompt event prints the injection block; no match prints nothing", async () => {
    o.stateRoot = path.join(dir, "state");
    const out = await runRulesMatch({ ...o, text: "round the invoice amount in vnd" }, cfgPath);
    expect(out).toContain("biz.invoice.vnd-rounding");
    expect(await runRulesMatch({ ...o, text: "thanks" }, cfgPath)).toBe("");
  });
  it("read event matches a rule glob; bad event errors; unknown project prints nothing", async () => {
    const rd = path.join(kbRulesDir(loadConfig(cfgPath), "saitex"), "business");
    fs.writeFileSync(path.join(rd, "biz.sol.md"), rule("biz.sol", "active", "triggers:\n  globs: ['**/*.sol']\n"));
    o.stateRoot = path.join(dir, "state");
    expect(await runRulesMatch({ ...o, path: path.join(dir, "flooros", "c", "A.sol") }, cfgPath)).toContain("biz.sol");
    await expect(runRulesMatch({ ...o, event: "edit" }, cfgPath)).rejects.toThrow(/--event/);
    expect(await runRulesMatch({ ...o, project: "nope", text: "invoice vnd" }, cfgPath)).toBe("");
  });
});

describe("knowledge feedback / stats / cite-scan (#901)", () => {
  const audit = (at = "2026-10-10T00:00:00Z") => ({ dir: process.env.SQUADRANT_AUDIT_DIR!, now: () => new Date(at), machineId: "m1" });
  const events = () => fs.readFileSync(path.join(process.env.SQUADRANT_AUDIT_DIR!, "2026-10.m1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

  it("feedback logs one item.outcome with kb/domain; unknown ids and projects fail", () => {
    runKnowledgeFeedback("biz.invoice.vnd-rounding", "violated", { project: "flooros", audit: audit(), env: {} }, cfgPath);
    expect(events()).toMatchObject([{ event: "item.outcome", outcome: "violated", itemId: "biz.invoice.vnd-rounding", domain: "rules", project: "flooros" }]);
    expect(() => runKnowledgeFeedback("nope", "noise", { project: "flooros", audit: audit(), env: {} }, cfgPath)).toThrow(/No rule 'nope'/);
  });
  it("cite-scan --text cites a surfaced id once; stats reflect surfaced, cited and feedback", async () => {
    await runRulesMatch({ project: "flooros", text: "round the invoice amount in vnd", session: "s1", env: {}, audit: audit(), stateRoot: path.join(dir, "state") }, cfgPath);
      const first = runKnowledgeCiteScan({ project: "flooros", text: "done: biz.invoice.vnd-rounding applied", audit: audit() });
      expect(first).toEqual(["biz.invoice.vnd-rounding"]);
      expect(runKnowledgeCiteScan({ project: "flooros", text: "done: biz.invoice.vnd-rounding applied", audit: audit() })).toEqual([]);
      runKnowledgeFeedback("biz.invoice.vnd-rounding", "noise", { project: "flooros", audit: audit(), env: {} }, cfgPath);
      const [s] = runKnowledgeStats({ project: "flooros", auditDir: process.env.SQUADRANT_AUDIT_DIR, now: new Date("2026-10-10T00:00:00Z") }, cfgPath);
      expect(s.items.map((x) => [x.itemId, x.surfaced, x.cited, x.noise, x.useRate])).toEqual([["biz.invoice.vnd-rounding", 1, 1, 1, 1]]);
      expect(renderStats([s]).join("\n")).toContain("use 100%");
      expect(runKnowledgeStats({ kb: "saitex", item: "nope", auditDir: process.env.SQUADRANT_AUDIT_DIR }, cfgPath)[0].items).toEqual([]);
  });
  it("cite-scan --git scans commit messages with their own timestamp and dedups by sha", async () => {
    await runRulesMatch({ project: "flooros", text: "round the invoice amount in vnd", session: "s1", env: {}, audit: audit("2026-10-08T00:00:00Z"), stateRoot: path.join(dir, "state") }, cfgPath);
    const git_run = () => "\x1eabc123\x1f2026-10-09T12:00:00Z\x1ffix: biz.invoice.vnd-rounding\n";
      expect(runKnowledgeCiteScan({ project: "flooros", git: "/repo", git_run, audit: audit() })).toEqual(["biz.invoice.vnd-rounding"]);
      expect(runKnowledgeCiteScan({ project: "flooros", git: "/repo", git_run, audit: audit() })).toEqual([]);
  });
  it("cite-scan --git reads every local branch, so unmerged crew-branch commits count", () => {
    const calls: string[][] = [];
    runKnowledgeCiteScan({ project: "flooros", git: "/repo", git_run: (a) => { calls.push(a); return ""; }, audit: audit() });
    expect(calls[0]).toContain("--all");
  });
});

describe("outcome sources and per-task delivery (#945)", () => {
  const audit = (env: NodeJS.ProcessEnv = {}) => ({ dir: process.env.SQUADRANT_AUDIT_DIR!, now: () => new Date("2026-10-10T00:00:00Z"), machineId: "m1", env });
  const events = () => fs.readFileSync(path.join(process.env.SQUADRANT_AUDIT_DIR!, "2026-10.m1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const t1 = { SQUADRANT_CREW_TASK_ID: "t1" };
  beforeEach(() => {
    const rd = path.join(kbRulesDir(loadConfig(cfgPath), "saitex"), "business");
    fs.writeFileSync(path.join(rd, "biz.tax.vat.md"), rule("biz.tax.vat", "active", "triggers:\n  keywords: [vat]\n").replace("modality: must", "modality: should").replace("VND amounts are rounded half-up.", "VAT is shown per line."));
  });

  it("feedback defaults to source operator; --source/--task are logged", () => {
    runKnowledgeFeedback("biz.invoice.vnd-rounding", "violated", { project: "flooros", audit: audit(), env: {} }, cfgPath);
    runKnowledgeFeedback("biz.invoice.vnd-rounding", "followed", { project: "flooros", audit: audit(), env: {}, source: "review", task: "t1" }, cfgPath);
    const [a, b] = events();
    expect(a).toMatchObject({ event: "item.outcome", outcome: "violated", source: "operator" });
    expect(a).not.toHaveProperty("task");
    expect(b).toMatchObject({ event: "item.outcome", outcome: "followed", source: "review", task: "t1" });
  });
  it("feedback rejects an unknown --source", () => {
    expect(() => runKnowledgeFeedback("biz.invoice.vnd-rounding", "followed", { project: "flooros", audit: audit(), env: {}, source: "judge?" }, cfgPath)).toThrow(/--source/);
  });

  it("knowledge surfaced --task lists exactly the ids delivered to that task, deduped, with modality + statement", async () => {
    await runRulesMatch({ project: "flooros", text: "round the invoice amount in vnd", session: "s1", env: t1, audit: audit(t1), stateRoot: path.join(dir, "state") }, cfgPath);
    runRulesShow("biz.invoice.vnd-rounding", { project: "flooros", env: t1, audit: audit(t1) }, cfgPath);
    runRulesSearch("vat", { project: "flooros", env: t1, audit: audit(t1) }, cfgPath);
    runRulesSearch("vat", { project: "flooros", env: { SQUADRANT_CREW_TASK_ID: "t2" }, audit: audit({ SQUADRANT_CREW_TASK_ID: "t2" }) }, cfgPath);
    runRulesShow("biz.invoice.vnd-rounding", { project: "flooros", env: {}, audit: audit() }, cfgPath);
    const got = runKnowledgeSurfaced("t1", { auditDir: process.env.SQUADRANT_AUDIT_DIR }, cfgPath);
    expect(got).toEqual([
      { id: "biz.invoice.vnd-rounding", kb: "saitex", project: "flooros", modality: "must", statement: "VND amounts are rounded half-up.", events: ["item.surfaced", "item.shown"] },
      { id: "biz.tax.vat", kb: "saitex", project: "flooros", modality: "should", statement: "VAT is shown per line.", events: ["item.searched"] },
    ]);
    expect(runKnowledgeSurfaced("t2", { auditDir: process.env.SQUADRANT_AUDIT_DIR }, cfgPath).map((x) => x.id)).toEqual(["biz.tax.vat"]);
    expect(runKnowledgeSurfaced("nope", { auditDir: process.env.SQUADRANT_AUDIT_DIR }, cfgPath)).toEqual([]);
    expect(renderSurfaced(got)[0]).toBe("biz.invoice.vnd-rounding  [must]  VND amounts are rounded half-up.");
  });

  it.each(["codex", "opencode", "claude"])("the %s delivery path stamps the same task from SQUADRANT_CREW_TASK_ID", async (agent) => {
    await runRulesMatch({ project: "flooros", agent, text: "round the invoice amount in vnd", session: `s-${agent}`, env: t1, audit: audit(t1), stateRoot: path.join(dir, "state") }, cfgPath);
    runRulesSearch("vat", { project: "flooros", env: t1, audit: audit(t1) }, cfgPath);
    const delivered = events();
    expect(delivered.map((e) => [e.event, e.task])).toEqual([["item.surfaced", "t1"], ["item.searched", "t1"]]);
    expect(delivered[0].agent).toBe(agent);
  });
});
