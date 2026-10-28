// #979 phase 2 (2b-1): every rules write command leaves the KB repo clean, one commit per run with the five trailers.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, saveConfig, loadConfig } from "@squadrant/shared";
import { finishReconcile, kbRulesDir, PROPOSED_DIR, readEscalations, readVerdicts } from "@squadrant/core";
import {
  runKnowledgeApply, runKnowledgeIngest, runKnowledgeInit, runKnowledgeResolve, runKnowledgeReviewApply, runKnowledgeSourcesRemove,
} from "../knowledge.js";
import { runKnowledgeDoctor } from "../knowledge-doctor.js";

let dir: string;
let cfgPath: string;
let kb: string;
const git = (...args: string[]) => execFileSync("git", ["-C", kb, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
const count = () => Number(git("rev-list", "--count", "HEAD").trim());
const status = () => git("status", "--porcelain", "--untracked-files=all");
const lastMsg = () => git("log", "-1", "--format=%B");
const TRAILERS = /\n\nDomain: \S+\n(Item: \S+\n)+Level: \S+\nSession: \S+\nApproved-by: \S+\n/;

const SOURCE = "# Policy\n\nInvoices must be issued within 5 days.\n\nRefunds must be approved by finance.\n";
const cand = (o: Record<string, unknown>) => ({ source: "raw/p.md", domain: "business", modality: "must", ...o });
const A = { id: "biz.invoice.window", statement: "Issue invoices within 5 days.", quote: "Invoices must be issued within 5 days." };
const B = { id: "biz.refund.approval", statement: "Finance approves refunds.", quote: "Refunds must be approved by finance." };
function candidates(name: string, list: Record<string, unknown>[], complete = true): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify({ ...(complete ? { complete: ["raw/p.md"] } : {}), candidates: list.map(cand) }));
  return f;
}
const proposalKey = (id: string) => fs.readdirSync(path.join(kbRulesDir(loadConfig(cfgPath), "acme"), PROPOSED_DIR)).find((n) => n.startsWith(`${id}@`))!.replace(/\.md$/, "");
function decisions(name: string, list: Record<string, unknown>[]): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify({ decisions: list }));
  return f;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-kb-write-"));
  vi.stubEnv("HOME", dir);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  for (const k of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) vi.stubEnv(k, "t");
  for (const k of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) vi.stubEnv(k, "t@t");
  vi.stubEnv("SQUADRANT_AUDIT_DIR", path.join(dir, "audit"));
  vi.stubEnv("SQUADRANT_VERDICTS_DIR", path.join(dir, "verdicts"));
  vi.stubEnv("SQUADRANT_CREW_TASK_ID", "task-1");
  cfgPath = path.join(dir, "config.json");
  const c = getDefaultConfig();
  c.hubVault = path.join(dir, "hub");
  c.knowledgeBases = { acme: { path: path.join(dir, "kb", "acme"), homeProject: "projA" } };
  c.projects = { projA: { path: path.join(dir, "projA"), captainName: "f", spokeVault: path.join(dir, "v"), host: "local", knowledge: ["acme"] } };
  saveConfig(c, cfgPath);
  fs.mkdirSync(path.join(dir, "projA"), { recursive: true });
  kb = path.join(dir, "kb", "acme");
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("each rules write command leaves the KB repo clean (2b-1)", () => {
  it("init, apply, review --apply, resolve, sources --remove, reconcile --finish: expected commits, five trailers, clean status", async () => {
    // init: one commit with .gitignore + sources.yaml; index.json and _proposed/ are ignored.
    runKnowledgeInit("acme", cfgPath);
    expect(count()).toBe(1);
    expect(lastMsg()).toMatch(/^knowledge: init acme/);
    expect(lastMsg()).toMatch(TRAILERS);
    expect(git("ls-files").trim().split("\n").sort()).toEqual([".gitignore", "sources.yaml"]);
    expect(status()).toBe("");

    // The operator edits sources.yaml by hand and commits it (not a squadrant write).
    fs.writeFileSync(path.join(kb, "sources.yaml"), "- path: raw/**\n  priority: company\n");
    fs.writeFileSync(path.join(kb, "raw", "p.md"), SOURCE);
    git("commit", "-qam", "sources");
    await runKnowledgeIngest("acme", {}, cfgPath);

    // apply: one commit per run, Item repeated.
    expect(runKnowledgeApply("acme", candidates("c1.json", [A, B]), cfgPath)).toMatchObject({ created: [A.id, B.id], warnings: [] });
    expect(count()).toBe(3);
    expect(lastMsg()).toMatch(/^knowledge: apply acme\n\nDomain: rules\nItem: biz\.invoice\.window\nItem: biz\.refund\.approval\nLevel: shared\nSession: task-1\nApproved-by: auto\n/);
    expect(status()).toBe("");

    // A meaning change lands in _proposed/: no commit, still clean.
    runKnowledgeApply("acme", candidates("c2.json", [{ ...A, statement: "Issue invoices within 7 days.", meaning: "changed" }, { ...B, statement: "Finance signs off refunds.", meaning: "changed" }]), cfgPath);
    expect(count()).toBe(3);
    expect(status()).toBe("");

    // review --apply: the confident approval is applied in one commit; the low-confidence one is escalated (no file change).
    const keyA = proposalKey(A.id), keyB = proposalKey(B.id);
    const r = runKnowledgeReviewApply("acme", decisions("d.json", [
      { item: keyA, decision: "approve", confidence: 0.95, justification: "policy changed" },
      { item: keyB, decision: "approve", confidence: 0.4, justification: "unsure" },
    ]), cfgPath);
    expect(r).toMatchObject({ applied: [keyA], warnings: [] });
    expect(count()).toBe(4);
    expect(lastMsg()).toMatch(/^knowledge: review --apply acme\n\nDomain: rules\nItem: biz\.invoice\.window\nLevel: shared\nSession: task-1\nApproved-by: reviewer-agent\n/);
    expect(status()).toBe("");

    // resolve: one commit for the one escalation.
    expect(readEscalations(kb).map((e) => e.key)).toEqual([keyB]);
    runKnowledgeResolve("acme", keyB, { kind: "approve" }, "op", "ok", cfgPath);
    expect(count()).toBe(5);
    expect(lastMsg()).toMatch(new RegExp(`^knowledge: resolve ${keyB.replace(/[.@]/g, "\\$&")}\\n\\nDomain: rules\\nItem: biz\\.refund\\.approval\\nLevel: shared\\nSession: task-1\\nApproved-by: operator\\n`));
    expect(status()).toBe("");
    // Verdicts went to the state dir, not the KB.
    expect(fs.existsSync(path.join(kb, "verdicts.jsonl"))).toBe(false);
    expect(readVerdicts("acme", kb).map((v) => v.outcome ?? (v.resolution as { kind: string }).kind)).toEqual(["applied", "escalated", "approve"]);

    // sources --remove: sources.yaml + the stripped rules in one commit.
    expect(runKnowledgeSourcesRemove("acme", "raw/**", {}, cfgPath)).toMatchObject({ stale: [A.id, B.id], warnings: [] });
    expect(count()).toBe(6);
    expect(git("show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual([
      "shared/rules/business/biz.invoice.window.md", "shared/rules/business/biz.refund.approval.md", "sources.yaml",
    ]);
    expect(lastMsg()).toMatch(TRAILERS);
    expect(status()).toBe("");

    // reconcile --finish: REPORT.md committed; scores/escalations ignored.
    await finishReconcile("acme", { cfg: loadConfig(cfgPath), stateRoot: path.join(dir, "state"), enqueue: async () => {}, auditDir: path.join(dir, "audit") });
    expect(count()).toBe(7);
    expect(lastMsg()).toMatch(/^knowledge: \w+ reconcile report/);
    expect(lastMsg()).toMatch(TRAILERS);
    expect(status()).toBe("");

    // knowledge doctor agrees.
    expect(runKnowledgeDoctor("acme", {}, cfgPath)[0].check).toMatchObject({ notRepo: false, missingIgnores: [], trackedNeverCommitted: [], uncommitted: [] });
  });

  it("a failed commit keeps the files, warns, and knowledge doctor lists them; --fix without a yes leaves them", async () => {
    runKnowledgeInit("acme", cfgPath);
    fs.writeFileSync(path.join(kb, "sources.yaml"), "- path: raw/**\n  priority: company\n");
    fs.writeFileSync(path.join(kb, "raw", "p.md"), SOURCE);
    git("commit", "-qam", "sources");
    await runKnowledgeIngest("acme", {}, cfgPath);
    // A stale index.lock that outlives the retries makes the commit fail.
    fs.writeFileSync(path.join(kb, ".git", "index.lock"), "");
    const res = runKnowledgeApply("acme", candidates("c1.json", [A]), cfgPath);
    expect(res.created).toEqual([A.id]);
    expect(res.warnings[0]).toMatch(/commit failed.*knowledge doctor --fix/);
    fs.rmSync(path.join(kb, ".git", "index.lock"));
    const file = "shared/rules/business/biz.invoice.window.md";
    expect(fs.existsSync(path.join(kb, file))).toBe(true);
    expect(runKnowledgeDoctor("acme", {}, cfgPath)[0].check.uncommitted).toEqual([file]);
    expect(runKnowledgeDoctor("acme", { fix: true }, cfgPath)[0].fix!.uncommitted).toEqual([file]);
    const fixed = runKnowledgeDoctor("acme", { fix: true, confirm: () => true }, cfgPath)[0];
    expect(fixed.fix!.committed).toEqual([file]);
    expect(status()).toBe("");
  });
});
