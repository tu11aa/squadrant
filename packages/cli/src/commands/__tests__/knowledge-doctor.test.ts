// `squadrant knowledge doctor [kb]` (#979 §4.1, §4.6). Synthetic KBs in a tmp dir.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getDefaultConfig, saveConfig } from "@squadrant/shared";
import { readIndex } from "@squadrant/core";
import { runKnowledgeDoctor } from "../knowledge-doctor.js";
import { knowledgeCommand } from "../knowledge.js";

let dir: string;
let cfgPath: string;
const saved = { cache: process.env.SQUADRANT_INDEX_CACHE_DIR, user: process.env.SQUADRANT_USER_KB_DIR };
const put = (rel: string, text: string) => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const rule = (id: string, category: string) =>
  `---\nid: ${id}\ndomain: ${category}\nmodality: must\nstatus: active\nsources:\n  - { ref: raw/a.md, sha: s, quote: q }\n---\nS.\n`;
const decision = (id: string, domain = "decisions") =>
  `---\nid: ${id}\ndomain: ${domain}\nstatus: accepted\nsources: ["session:abc"]\ncreated: 2026-10-08\nupdated: 2026-10-08\n---\n# T\n`;
const messages = (r: ReturnType<typeof runKnowledgeDoctor>) => r.checks.map((c) => `${c.level} ${c.message}`);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-doctor-"));
  process.env.SQUADRANT_INDEX_CACHE_DIR = path.join(dir, "cache");
  process.env.SQUADRANT_USER_KB_DIR = path.join(dir, "user");
  cfgPath = path.join(dir, "config.json");
  const c = getDefaultConfig();
  c.knowledgeBases = { acme: { path: path.join(dir, "kb", "acme") }, globex: { path: path.join(dir, "kb", "globex") } };
  saveConfig(c, cfgPath);
  put("kb/acme/shared/rules/coding/coding.a.md", rule("coding.a", "coding"));
  put("kb/acme/shared/decisions/dec.x.md", decision("dec.x"));
  put("kb/globex/shared/rules/coding/coding.g.md", rule("coding.g", "coding"));
  fs.mkdirSync(path.join(dir, "user", "profile"), { recursive: true });
});
afterEach(() => {
  process.env.SQUADRANT_INDEX_CACHE_DIR = saved.cache;
  process.env.SQUADRANT_USER_KB_DIR = saved.user;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("knowledge doctor", () => {
  it("is registered on `squadrant knowledge`", () => {
    expect(knowledgeCommand.commands.filter((c) => c.name() === "doctor")).toHaveLength(1); // one command for 2a checks and 2b-1 --fix
    expect(knowledgeCommand.commands.find((c) => c.name() === "doctor")!.options.map((x) => x.long)).toEqual(["--fix"]);
  });
  it("the repo half skips a configured KB that is not on disk (reported by the item half instead)", async () => {
    const { runKbRepoDoctor } = await import("../knowledge-doctor.js");
    fs.rmSync(path.join(dir, "kb", "globex"), { recursive: true });
    for (const kb of ["acme"]) execFileSync("git", ["init", "-q", path.join(dir, "kb", kb)]);
    expect(runKbRepoDoctor(undefined, {}, cfgPath).map((e) => e.check.kb)).toEqual(["acme"]);
  });
  it("covers every configured KB plus _user by default and rebuilds missing index caches", () => {
    const r = runKnowledgeDoctor(undefined, cfgPath);
    expect(r.ok).toBe(true);
    expect(messages(r)).toEqual([
      "ok acme: 2 live items valid",
      expect.stringMatching(/^ok acme: index cache rebuilt \(index cache missing for kb 'acme'\)/),
      "ok globex: 1 live items valid",
      expect.stringMatching(/^ok globex: index cache rebuilt/),
      "ok _user: 0 live items valid",
      "ok audit log: every line belongs to a known KB",
    ]);
    expect(readIndex("acme").index?.rules.map((x) => x.id)).toEqual(["coding.a"]);
    expect(messages(runKnowledgeDoctor("acme", cfgPath))).toContain("ok acme: index cache valid");
  });
  it("rebuilds the index after rm -rf of the cache dir", () => {
    runKnowledgeDoctor("globex", cfgPath);
    fs.rmSync(path.join(dir, "cache"), { recursive: true, force: true });
    expect(messages(runKnowledgeDoctor("globex", cfgPath))).toContainEqual(expect.stringMatching(/^ok globex: index cache rebuilt/));
    expect(readIndex("globex").index?.rules.map((x) => x.id)).toEqual(["coding.g"]);
  });
  it("fails on D3/D4 item problems (incl. _proposed/) and exits non-zero; writes nothing in the KB", () => {
    put("kb/acme/shared/decisions/dec.w.md", decision("dec.w", "wiki"));
    put("kb/acme/shared/rules/_proposed/dec.r.md", rule("dec.r", "coding"));
    put("user/profile/x.md", "---\nid: x\ndomain: profile\n---\nbody\n");
    const before = execFileSync("find", [path.join(dir, "kb"), path.join(dir, "user")], { encoding: "utf8" });
    const r = runKnowledgeDoctor(undefined, cfgPath);
    expect(r.ok).toBe(false);
    const fails = r.checks.filter((c) => c.level === "fail").map((c) => c.message);
    expect(fails).toEqual([
      expect.stringMatching(/^acme: shared\/decisions\/dec\.w\.md: .*\(D3\)/),
      expect.stringMatching(/^acme: shared\/rules\/_proposed\/dec\.r\.md: .*reserved prefix 'dec\.'/),
      expect.stringMatching(/^_user: profile\/x\.md: .*must start with 'prof\.'/),
    ]);
    expect(execFileSync("find", [path.join(dir, "kb"), path.join(dir, "user")], { encoding: "utf8" })).toBe(before);
  });
  it("hints at untracking a legacy <kb>/index.json, never runs it", () => {
    const kb = path.join(dir, "kb", "acme");
    execFileSync("git", ["init", "-q", kb]);
    fs.writeFileSync(path.join(kb, "index.json"), "{}\n");
    execFileSync("git", ["-C", kb, "add", "index.json"]);
    const r = runKnowledgeDoctor("acme", cfgPath);
    expect(r.ok).toBe(true);
    expect(r.checks).toContainEqual({ level: "warn", message: expect.stringContaining(`run: squadrant knowledge doctor acme --fix`) });
    expect(execFileSync("git", ["-C", kb, "ls-files", "index.json"], { encoding: "utf8" }).trim()).toBe("index.json");
  });
  it("a missing KB: warn by default, fail when named; rejects a bad name", () => {
    fs.rmSync(path.join(dir, "kb", "globex"), { recursive: true });
    expect(runKnowledgeDoctor(undefined, cfgPath).checks).toContainEqual({ level: "warn", message: expect.stringContaining("globex: not found") });
    expect(runKnowledgeDoctor("globex", cfgPath)).toMatchObject({ ok: false });
    expect(() => runKnowledgeDoctor("../x", cfgPath)).toThrow(/Invalid knowledge base name/);
  });
});

describe("knowledge doctor: audit-log health", () => {
  it("counts lines of an unknown kb (the test leak) and no-home lines; clean log is ok", async () => {
    const { globalChecks } = await import("../knowledge-doctor.js");
    const { loadConfig } = await import("@squadrant/shared");
    const audit = path.join(dir, "audit");
    fs.mkdirSync(audit, { recursive: true });
    const cfg = loadConfig(cfgPath);
    expect(globalChecks(cfg, audit)).toEqual([{ level: "ok", message: "audit log: every line belongs to a known KB" }]);
    cfg.projects.lone = { path: path.join(dir, "lone"), captainName: "l", spokeVault: path.join(dir, "v"), host: "local" };
    const line = (o: object) => JSON.stringify({ ts: "2026-10-10T00:00:00Z", level: "shared", domain: "rules", itemId: "coding.a", event: "item.surfaced", ...o });
    fs.writeFileSync(path.join(audit, "2026-10.m.jsonl"), [
      line({ kb: "acme", project: "p" }), line({ kb: "t", project: "" }), line({ kb: "t", project: "" }), line({ kb: "", level: "project", project: "lone" }),
    ].join("\n") + "\n");
    expect(globalChecks(cfg, audit).map((c) => `${c.level} ${c.message}`)).toEqual([
      'warn audit log: 2 lines ignored by scoring, kb unknown to config: "t" 2',
      "warn audit log: 1 lines from projects with no knowledge home, shown as (no home) in knowledge stats",
    ]);
  });
});
