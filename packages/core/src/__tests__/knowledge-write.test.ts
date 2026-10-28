// #979 phase 2 (2b-1): the shared KB writer, the D7 layout, `knowledge doctor --fix`, verdicts in the state dir.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import {
  appendVerdict, applyCandidates, applyDecisions, kbRulesDir, planIngest, type ReviewContext, checkKbRepo, checkOverrides, commitKbFiles, commitKbPaths, ensureGitRepo, ensureKbGitignore, fixKbRepo, kbRootOf, readVerdicts,
  KB_RUNTIME_IGNORES,
} from "../knowledge/index.js";

let root: string;
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
const commits = (repo: string) => Number(git(repo, "rev-list", "--count", "HEAD").trim());
const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-write-"));
  // Hermetic git: no operator ~/.gitconfig, hooks or identity.
  vi.stubEnv("HOME", root);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  for (const k of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) vi.stubEnv(k, "t");
  for (const k of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) vi.stubEnv(k, "t@t");
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

function newKb(name = "kb"): string {
  const kb = path.join(root, name);
  fs.mkdirSync(kb, { recursive: true });
  ensureGitRepo(kb);
  ensureKbGitignore(kb);
  git(kb, "add", ".gitignore");
  git(kb, "commit", "-q", "-m", "init");
  return kb;
}
const trailers = { domain: "rules", items: ["coding.a", "coding.b"], level: "shared", session: "s1", approvedBy: "auto" };

describe("commitKbPaths (D1)", () => {
  it("commits exactly its paths with the five trailers, Item repeated; another writer's staged file is not swept in", () => {
    const kb = newKb();
    put(path.join(kb, "shared/rules/coding/other.md"), "o");
    git(kb, "add", "shared/rules/coding/other.md");
    put(path.join(kb, "shared/rules/coding/coding.a.md"), "a");
    put(path.join(kb, "shared/rules/coding/coding.b.md"), "b");
    const r = commitKbPaths(kb, [path.join(kb, "shared/rules/coding/coding.a.md"), "shared/rules/coding/coding.b.md"], { message: "knowledge: apply kb", trailers });
    expect(r).toEqual({ ok: true, committed: true });
    expect(git(kb, "show", "--name-only", "--format=", "HEAD").trim().split("\n")).toEqual(["shared/rules/coding/coding.a.md", "shared/rules/coding/coding.b.md"]);
    const msg = git(kb, "log", "-1", "--format=%B");
    expect(msg).toMatch(/^knowledge: apply kb\n\nDomain: rules\nItem: coding\.a\nItem: coding\.b\nLevel: shared\nSession: s1\nApproved-by: auto\n/);
    expect(git(kb, "diff", "--cached", "--name-only").trim()).toBe("shared/rules/coding/other.md");
  });
  it("commits a deletion; unchanged or ignored paths make no commit", () => {
    const kb = newKb();
    put(path.join(kb, "shared/rules/x.md"), "x");
    commitKbPaths(kb, ["shared/rules/x.md"], { message: "add", trailers });
    const n = commits(kb);
    expect(commitKbPaths(kb, ["shared/rules/x.md"], { message: "noop", trailers })).toEqual({ ok: true, committed: false });
    put(path.join(kb, "index.json"), "{}");
    expect(commitKbPaths(kb, ["index.json"], { message: "ignored", trailers })).toEqual({ ok: true, committed: false });
    expect(commits(kb)).toBe(n);
    fs.rmSync(path.join(kb, "shared/rules/x.md"));
    expect(commitKbPaths(kb, ["shared/rules/x.md"], { message: "rm", trailers }).committed).toBe(true);
    expect(git(kb, "status", "--porcelain")).toBe("");
  });
  it("refuses _proposed/ paths and paths outside the KB; a non-repo keeps the files and warns", () => {
    const kb = newKb();
    fs.rmSync(path.join(kb, ".gitignore"));
    put(path.join(kb, "shared/rules/_proposed/p.md"), "secret");
    const r = commitKbPaths(kb, ["shared/rules/_proposed/p.md"], { message: "x", trailers });
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/proposals are never committed/);
    expect(commitKbPaths(kb, [path.join(root, "elsewhere.md")], { message: "x", trailers }).warning).toMatch(/outside the KB/);
    expect(git(kb, "log", "--all", "--name-only", "--format=")).not.toContain("_proposed");
    const plain = path.join(root, "plain");
    put(path.join(plain, "a.md"), "a");
    const nr = commitKbPaths(plain, ["a.md"], { message: "x", trailers });
    expect(nr).toMatchObject({ ok: false, committed: false });
    expect(nr.warning).toMatch(/not a git repo.*knowledge doctor --fix/);
    expect(fs.existsSync(path.join(plain, "a.md"))).toBe(true);
  });
  it("concurrent writers (two processes) both commit their own paths; neither sweeps the other's", async () => {
    const kb = newKb();
    const writer = path.resolve(__dirname, "../../dist/knowledge/write.js");
    expect(fs.existsSync(writer), "run pnpm build first: the child processes load the built writer").toBe(true);
    const go = path.join(root, "go");
    const script = (who: string) => `
      import fs from "node:fs";
      import { commitKbPaths } from ${JSON.stringify(writer)};
      while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 5; i++) {
        const rel = "shared/rules/coding/${who}." + i + ".md";
        fs.mkdirSync(${JSON.stringify(path.join(kb, "shared/rules/coding"))}, { recursive: true });
        fs.writeFileSync(${JSON.stringify(kb)} + "/" + rel, "${who} " + i);
        const r = commitKbPaths(${JSON.stringify(kb)}, [rel], { message: "${who} " + i, trailers: { domain: "rules", items: ["${who}." + i], level: "shared", approvedBy: "auto" } });
        if (!r.committed) { console.error(JSON.stringify(r)); process.exit(1); }
      }`;
    const run = (who: string) => new Promise<number>((resolve) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", script(who)], { stdio: ["ignore", "ignore", "inherit"], env: process.env });
      p.on("exit", (code) => resolve(code ?? 1));
    });
    const both = Promise.all([run("a"), run("b")]);
    setTimeout(() => fs.writeFileSync(go, ""), 300);
    expect(await both).toEqual([0, 0]);
    expect(commits(kb)).toBe(11);
    for (const sha of git(kb, "rev-list", "HEAD~10..HEAD").trim().split("\n")) {
      const subject = git(kb, "log", "-1", "--format=%s", sha).trim();
      const [who, i] = subject.split(" ");
      expect(git(kb, "show", "--name-only", "--format=", sha).trim()).toBe(`shared/rules/coding/${who}.${i}.md`);
    }
    expect(git(kb, "status", "--porcelain")).toBe("");
  }, 30_000);
});

describe("commitKbFiles: owning KB and repo:docs (D6)", () => {
  function cfgWith(kb: string, docsRepo: string): SquadrantConfig {
    const c = getDefaultConfig();
    c.knowledgeBases = { t: { path: kb } };
    c.projects = {
      inkb: { path: path.join(root, "inkb"), captainName: "i", spokeVault: path.join(root, "v"), host: "local", knowledgeHome: "kb:t", knowledge: ["t"] },
      docs: { path: docsRepo, captainName: "d", spokeVault: path.join(root, "v2"), host: "local", knowledgeHome: "repo:docs", knowledge: ["t"] },
    };
    return c;
  }
  it("a KB overlay is committed with Level: project; a repo:docs overlay is written and never committed", () => {
    const kb = newKb("t");
    const docs = newKb("docs-repo");
    const cfg = cfgWith(kb, docs);
    const inKb = path.join(kb, "projects/inkb/rules/coding/coding.o.md");
    const inDocs = path.join(docs, "docs/rules/coding/coding.o.md");
    put(inKb, "k");
    put(inDocs, "d");
    expect(kbRootOf(cfg, inKb)).toBe(path.resolve(kb));
    expect(kbRootOf(cfg, inDocs)).toBeUndefined();
    const before = commits(docs);
    expect(commitKbFiles(cfg, [inKb, inDocs], { message: "knowledge: stamp", trailers: { domain: "rules", session: "-", approvedBy: "auto" } })).toEqual([]);
    expect(git(kb, "log", "-1", "--format=%B")).toContain("Item: coding.o\nLevel: project");
    expect(git(kb, "status", "--porcelain")).toBe("");
    expect(commits(docs)).toBe(before);
    expect(git(docs, "status", "--porcelain", "--untracked-files=all")).toContain("docs/rules/coding/coding.o.md");
  });
  it("checkOverrides stamps the baseline: committed in a KB overlay, a working-tree diff for repo:docs", () => {
    const kb = newKb("t");
    const docs = newKb("docs-repo");
    const cfg = cfgWith(kb, docs);
    const rule = (id: string) => `---\nid: ${id}\ndomain: coding\nmodality: must\nstatus: active\nsources:\n  - { ref: raw/a.md, sha: abc, quote: q }\n---\nS.\n`;
    put(path.join(kb, "shared/rules/coding/coding.o.md"), rule("coding.o"));
    git(kb, "add", "-A"); git(kb, "commit", "-q", "-m", "rule");
    put(path.join(kb, "projects/inkb/rules/coding/coding.o.md"), rule("coding.o"));
    put(path.join(docs, "docs/rules/coding/coding.o.md"), rule("coding.o"));
    git(kb, "add", "-A"); git(kb, "commit", "-q", "-m", "overlay");
    git(docs, "add", "-A"); git(docs, "commit", "-q", "-m", "overlay");
    const before = commits(docs);
    checkOverrides(cfg, "t");
    expect(fs.readFileSync(path.join(kb, "projects/inkb/rules/coding/coding.o.md"), "utf8")).toContain("overridesBase:");
    expect(git(kb, "status", "--porcelain")).toBe("");
    expect(git(kb, "log", "-1", "--format=%s").trim()).toBe("knowledge: stamp override baselines");
    expect(commits(docs)).toBe(before);
    expect(git(docs, "status", "--porcelain").trim()).toBe("M docs/rules/coding/coding.o.md");
  });
});

describe("knowledge doctor (C3)", () => {
  /** A pre-phase-2 KB: index.json, verdicts.jsonl and a proposal tracked; an old .gitignore. */
  function legacyKb(): string {
    const kb = path.join(root, "legacy");
    fs.mkdirSync(kb, { recursive: true });
    ensureGitRepo(kb);
    put(path.join(kb, ".gitignore"), "raw/\n");
    put(path.join(kb, "index.json"), "{}\n");
    put(path.join(kb, "verdicts.jsonl"), '{"kb":"legacy","kind":"operator"}\n');
    put(path.join(kb, "shared/rules/_proposed/coding.p@abc.md"), "p");
    put(path.join(kb, "shared/rules/coding/coding.a.md"), "a");
    git(kb, "add", "-A"); git(kb, "commit", "-q", "-m", "legacy");
    return kb;
  }
  it("reports missing ignores, tracked never-committed files and outside edits", () => {
    const kb = legacyKb();
    put(path.join(kb, "shared/rules/coding/coding.a.md"), "edited by hand");
    put(path.join(kb, "shared/rules/coding/coding.new.md"), "new");
    const c = checkKbRepo("legacy", kb);
    expect(c.missingIgnores).toEqual(KB_RUNTIME_IGNORES);
    expect(c.trackedNeverCommitted).toEqual(["index.json", "shared/rules/_proposed/coding.p@abc.md", "verdicts.jsonl"]);
    expect(c.uncommitted).toEqual(["shared/rules/coding/coding.a.md", "shared/rules/coding/coding.new.md"]);
  });
  it("--fix: ensures .gitignore and untracks in one commit (files kept), lists outside edits and never commits them silently", () => {
    const kb = legacyKb();
    put(path.join(kb, "shared/rules/coding/coding.a.md"), "edited by hand");
    put(path.join(kb, "other-writer.md"), "staged elsewhere");
    git(kb, "add", "other-writer.md");
    const n = commits(kb);
    const r = fixKbRepo("legacy", kb, { session: "s9" });
    expect(r.warnings).toEqual([]);
    expect(commits(kb)).toBe(n + 1);
    expect(git(kb, "show", "--name-status", "--format=", "HEAD").trim().split("\n").sort()).toEqual([
      "D\tindex.json", "D\tshared/rules/_proposed/coding.p@abc.md", "D\tverdicts.jsonl", "M\t.gitignore",
    ]);
    expect(git(kb, "log", "-1", "--format=%B")).toContain("Session: s9\nApproved-by: operator");
    for (const f of ["index.json", "verdicts.jsonl", "shared/rules/_proposed/coding.p@abc.md"]) expect(fs.existsSync(path.join(kb, f))).toBe(true);
    // The other writer's staged file is still staged and was not committed.
    expect(git(kb, "diff", "--cached", "--name-only").trim()).toBe("other-writer.md");
    expect(r.uncommitted).toEqual(["other-writer.md", "shared/rules/coding/coding.a.md"]);
    const after = checkKbRepo("legacy", kb);
    expect(after).toMatchObject({ missingIgnores: [], trackedNeverCommitted: [] });
    // Idempotent: a second --fix makes no commit.
    fixKbRepo("legacy", kb);
    expect(commits(kb)).toBe(n + 1);
  });
  it("--fix with a yes: each outside edit is its own commit, Approved-by: operator, Session: -", () => {
    const kb = legacyKb();
    put(path.join(kb, "shared/rules/coding/coding.a.md"), "edited by hand");
    put(path.join(kb, "projects/p/rules/coding/coding.o.md"), "overlay");
    const asked: string[][] = [];
    const r = fixKbRepo("legacy", kb, { confirm: (files) => { asked.push(files); return true; } });
    expect(asked).toEqual([["projects/p/rules/coding/coding.o.md", "shared/rules/coding/coding.a.md"]]);
    expect(r.committed).toEqual(asked[0]);
    expect(git(kb, "status", "--porcelain")).toBe("");
    const msg = git(kb, "log", "-1", "--format=%B");
    expect(msg).toContain("Domain: rules\nItem: coding.a\nLevel: shared\nSession: -\nApproved-by: operator");
    expect(git(kb, "log", "-2", "--format=%B")).toContain("Domain: rules\nItem: coding.o\nLevel: project");
  });
  it("a KB that is not a git repo is reported, not fixed", () => {
    const kb = path.join(root, "plain");
    fs.mkdirSync(kb);
    expect(checkKbRepo("plain", kb).notRepo).toBe(true);
    expect(fixKbRepo("plain", kb).warnings[0]).toMatch(/not a git repo/);
  });
});

describe("verdicts in the state dir (D7, C5)", () => {
  it("writes per machine under the verdicts dir, never the KB; reads every machine plus the old KB-root file", () => {
    const kb = newKb();
    const dir = path.join(root, "verdicts");
    appendVerdict("kb", { kind: "review", item: "a" }, new Date("2026-10-01T00:00:00Z"), { dir, machineId: "m1" });
    appendVerdict("kb", { kind: "review", item: "b" }, new Date("2026-10-02T00:00:00Z"), { dir, machineId: "m2" });
    appendVerdict("other", { kind: "review", item: "c" }, new Date("2026-10-02T00:00:00Z"), { dir, machineId: "m2" });
    expect(fs.readdirSync(dir).sort()).toEqual(["2026-10.m1.jsonl", "2026-10.m2.jsonl"]);
    expect(fs.existsSync(path.join(kb, "verdicts.jsonl"))).toBe(false);
    fs.writeFileSync(path.join(kb, "verdicts.jsonl"), JSON.stringify({ kb: "kb", kind: "operator", item: "old" }) + "\n");
    expect(readVerdicts("kb", kb, dir).map((v) => v.item)).toEqual(["a", "b", "old"]);
  });
  it("defaults to SQUADRANT_VERDICTS_DIR", () => {
    vi.stubEnv("SQUADRANT_VERDICTS_DIR", path.join(root, "env-verdicts"));
    appendVerdict("kb", { kind: "review", item: "a" }, new Date("2026-10-01T00:00:00Z"), { machineId: "m" });
    expect(fs.readdirSync(path.join(root, "env-verdicts"))).toEqual(["2026-10.m.jsonl"]);
  });
});

describe("two machines, one KB remote (2b-1)", () => {
  it("each clone writes rules, audit and verdicts; both push and pull with no conflicts; scores see both machines' verdicts", async () => {
    const origin = path.join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    const seed = newKb("seed");
    put(path.join(seed, "sources.yaml"), "- path: raw/**\n  priority: company\n");
    git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "sources");
    git(seed, "push", "-q", origin, "HEAD:main");
    const SOURCE = "# Policy\n\nInvoices must be issued within 5 days.\n\nRefunds must be approved by finance.\n";
    const A = { id: "biz.invoice.window", statement: "Issue invoices within 5 days.", quote: "Invoices must be issued within 5 days." };
    const B = { id: "biz.refund.approval", statement: "Finance approves refunds.", quote: "Refunds must be approved by finance." };
    const cand = (o: Record<string, unknown>) => ({ source: "raw/p.md", domain: "business", modality: "must", ...o });
    const state = path.join(root, "state"); // a synced state dir: per-machine file names keep the machines apart
    const SOURCES = [{ path: "raw/**", priority: "company" as const }];

    async function machine(name: string) {
      const kb = path.join(root, name);
      execFileSync("git", ["clone", "-q", "--branch", "main", origin, kb]);
      const cfg = getDefaultConfig();
      cfg.knowledgeBases = { t: { path: kb } };
      cfg.projects = {};
      put(path.join(kb, "raw/p.md"), SOURCE); // raw/ is local to each machine
      await planIngest(kb, { sources: SOURCES });
      const audit = { dir: path.join(state, "audit"), machineId: name };
      const ctx: ReviewContext = { cfg, kb: "t", sources: SOURCES, audit, verdicts: { dir: path.join(state, "verdicts"), machineId: name } };
      const apply = (list: Record<string, unknown>[]) => applyCandidates({ candidates: list.map(cand) }, { kb: "t", kbRoot: kb, rulesDir: kbRulesDir(cfg, "t"), sources: SOURCES, audit });
      return { kb, ctx, apply };
    }

    const m1 = await machine("m1");
    m1.apply([A, B]);
    git(m1.kb, "push", "-q", "origin", "HEAD:main");
    const m2 = await machine("m2");

    // Each machine proposes and approves a change to a different rule; proposals and verdicts stay local.
    m1.apply([{ ...A, statement: "Issue invoices within 7 days.", meaning: "changed" }]);
    m2.apply([{ ...B, statement: "Finance signs off refunds.", meaning: "changed" }]);
    const key = (kb: string, id: string) => fs.readdirSync(path.join(kb, "shared/rules/_proposed")).find((n) => n.startsWith(`${id}@`))!.replace(/\.md$/, "");
    applyDecisions({ decisions: [{ item: key(m1.kb, A.id), decision: "approve", confidence: 0.95, justification: "m1" }] }, m1.ctx);
    applyDecisions({ decisions: [{ item: key(m2.kb, B.id), decision: "approve", confidence: 0.95, justification: "m2" }] }, m2.ctx);
    for (const m of [m1, m2]) expect(git(m.kb, "status", "--porcelain", "--untracked-files=all")).toBe("");

    git(m1.kb, "push", "-q", "origin", "HEAD:main");
    git(m2.kb, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main"); // a clean merge: no index.json / verdicts.jsonl to fight over
    git(m2.kb, "push", "-q", "origin", "HEAD:main");
    git(m1.kb, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main");
    expect(git(m1.kb, "rev-parse", "HEAD")).toBe(git(m2.kb, "rev-parse", "HEAD"));
    for (const m of [m1, m2]) {
      expect(git(m.kb, "status", "--porcelain", "--untracked-files=all")).toBe("");
      expect(git(m.kb, "ls-files")).not.toMatch(/index\.json|verdicts\.jsonl|_proposed/);
      expect(fs.readFileSync(path.join(m.kb, "shared/rules/business/biz.invoice.window.md"), "utf8")).toContain("7 days");
      expect(fs.readFileSync(path.join(m.kb, "shared/rules/business/biz.refund.approval.md"), "utf8")).toContain("signs off");
    }
    expect(fs.readdirSync(path.join(state, "verdicts")).sort()).toEqual([expect.stringMatching(/\.m1\.jsonl$/), expect.stringMatching(/\.m2\.jsonl$/)]);
    expect(readVerdicts("t", m1.kb, path.join(state, "verdicts")).map((v) => v.justification).sort()).toEqual(["m1", "m2"]);
  }, 30_000);
});
