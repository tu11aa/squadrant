import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { getDefaultConfig, type KnowledgeSourceEntry, type SquadrantConfig } from "@squadrant/shared";
import {
  acquirePass, applyCandidates, applyDecisions, buildReviewPacket, changedRefs, checkOverrides, completePass, dedupPairs, domainCapExcess,
  duePass, evaluateCodeConflict, finishReconcile, kbDir, kbRulesDir, loadKbRules, planIngest, proposeAgentRule, readEscalations,
  readSchedule, requestPass, resolveEscalation, tickKnowledgeSchedule, usageReview, writeSchedule, RUNNING_STALE_MS,
  type CandidateFile, type Converter, type GitSeam, type ReviewContext,
} from "../knowledge/index.js";

const FIX = path.join(__dirname, "fixtures", "knowledge-golden");
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-10T00:00:00Z");
const at = (days: number, hours = 0) => new Date(T0.getTime() + days * DAY + hours * 3600_000);
const SOURCES: KnowledgeSourceEntry[] = [{ path: "raw/**", priority: "company" }];

let root: string;
let cfg: SquadrantConfig;
let stateRoot: string;
let mailbox: { project: string; text: string }[];
let clock: Date;

const kbRoot = () => kbDir(cfg, "t");
const enqueue = async (project: string, text: string) => { mailbox.push({ project, text }); };
const deps = () => ({ cfg, stateRoot, enqueue, now: () => clock });
const ctx = (extra: Partial<ReviewContext> = {}): ReviewContext => ({ cfg, kb: "t", sources: SOURCES, audit: { dir: path.join(root, "audit"), machineId: "m" }, now: () => clock, ...extra });
const preConverted = (dir: string): Converter => async (file) => fs.readFileSync(path.join(dir, `${path.basename(file)}.md`), "utf8");
const cands = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8")) as CandidateFile;
const ingest = () => planIngest(kbRoot(), { sources: SOURCES, converter: preConverted(path.join(FIX, "converted")) });
const applyV1 = () => applyCandidates(cands("candidates-v1.json"), { kb: "t", kbRoot: kbRoot(), rulesDir: kbRulesDir(cfg, "t"), audit: { dir: path.join(root, "audit"), machineId: "m" } });
const auditEvents = () => fs.readdirSync(path.join(root, "audit")).flatMap((f) => fs.readFileSync(path.join(root, "audit", f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));

function liveRule(id: string, extra = "", domain = "coding", modality = "must") {
  const dir = path.join(kbRulesDir(cfg, "t"), domain);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), `---\nid: ${id}\ndomain: ${domain}\nmodality: ${modality}\nstatus: active\nsources:\n  - { ref: raw/billing-policy.md, sha: abc123abc123abc, quote: q }\n${extra}---\nStatement of ${id}.\n`);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-reconcile-"));
  cfg = getDefaultConfig();
  cfg.hubVault = path.join(root, "hub");
  cfg.knowledgeBases = { t: { path: path.join(root, "kb", "t"), homeProject: "flooros" } };
  cfg.projects = { flooros: { path: path.join(root, "flooros"), captainName: "f", spokeVault: path.join(root, "spoke"), host: "local", group: "g" } };
  cfg.groups = { g: { kb: "t" } };
  stateRoot = path.join(root, "state");
  mailbox = [];
  clock = T0;
  fs.mkdirSync(path.join(kbRoot(), "raw"), { recursive: true });
  fs.mkdirSync(path.join(root, "flooros"), { recursive: true });
  fs.writeFileSync(path.join(kbRoot(), "sources.yaml"), "- path: raw/**\n  priority: company\n");
  fs.cpSync(path.join(FIX, "raw"), path.join(kbRoot(), "raw"), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("duePass (pure windows)", () => {
  const rc = { incrementalAfterDays: 7, fullEveryDays: 30, autoApproveConfidence: 0.8 };
  it("empty KB is due immediately, once", () => {
    expect(duePass({}, { now: T0, rc, empty: true })).toBe("full");
    expect(duePass({ lastFullAt: T0.toISOString(), createdAt: T0.toISOString() }, { now: at(1), rc, empty: true })).toBeNull();
  });
  it("incremental fires 7d after the first change and not before; full every 30d", () => {
    const e = { createdAt: T0.toISOString(), lastFullAt: T0.toISOString(), firstChangeAt: T0.toISOString(), incrementalDueAt: at(7).toISOString() };
    expect(duePass(e, { now: at(6, 23), rc, empty: false })).toBeNull();
    expect(duePass(e, { now: at(7), rc, empty: false })).toBe("incremental");
    expect(duePass({ createdAt: T0.toISOString(), lastFullAt: T0.toISOString() }, { now: at(30), rc, empty: false })).toBe("full");
  });
  it("full absorbs a due incremental", () => {
    const e = { createdAt: T0.toISOString(), lastFullAt: T0.toISOString(), firstChangeAt: at(20).toISOString(), incrementalDueAt: at(27).toISOString() };
    expect(duePass(e, { now: at(31), rc, empty: false })).toBe("full");
  });
});

describe("tickKnowledgeSchedule", () => {
  it("fixed incremental window: later changes do not push it back; request goes to the home captain mailbox", async () => {
    liveRule("coding.a");
    schedSeed({ lastFullAt: T0.toISOString() });
    clock = at(1);
    expect(await tickKnowledgeSchedule(deps())).toEqual([]);
    const first = readSchedule(stateRoot).t;
    expect(first.firstChangeAt).toBe(at(1).toISOString());
    expect(first.incrementalDueAt).toBe(at(8).toISOString());
    fs.appendFileSync(path.join(kbRoot(), "raw", "billing-policy.md"), "\nmore\n");
    clock = at(4);
    await tickKnowledgeSchedule(deps());
    expect(readSchedule(stateRoot).t.incrementalDueAt).toBe(at(8).toISOString());
    clock = at(8);
    const r = await tickKnowledgeSchedule(deps());
    expect(r).toEqual([{ kb: "t", pass: "incremental", requested: true }]);
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0].project).toBe("flooros");
    expect(mailbox[0].text).toContain("incremental reconcile due");
  });

  it("single-flight: no second request while running; a >6h running entry is taken over", async () => {
    liveRule("coding.a");
    schedSeed({ lastFullAt: T0.toISOString(), firstChangeAt: T0.toISOString(), incrementalDueAt: T0.toISOString() });
    clock = at(1);
    expect((await tickKnowledgeSchedule(deps())).map((x) => x.requested)).toEqual([true]);
    clock = at(1, 5);
    expect(await tickKnowledgeSchedule(deps())).toEqual([]);
    expect((await requestPass("t", "incremental", deps())).requested).toBe(false);
    clock = at(1, 7);
    expect((await tickKnowledgeSchedule(deps())).map((x) => x.requested)).toEqual([true]);
    expect(mailbox).toHaveLength(2);
    // pure lock semantics
    const e = { running: { pass: "full" as const, startedAt: T0.toISOString(), sourceSnapshot: {} } };
    expect(acquirePass(e, "incremental", new Date(T0.getTime() + RUNNING_STALE_MS), {})).toBe(false);
    expect(acquirePass(e, "incremental", new Date(T0.getTime() + RUNNING_STALE_MS + 1), {})).toBe(true);
  });

  it("a failed enqueue releases the lock", async () => {
    liveRule("coding.a");
    schedSeed({ lastFullAt: T0.toISOString() });
    await expect(requestPass("t", "full", { ...deps(), enqueue: async () => { throw new Error("mailbox down"); } })).rejects.toThrow("mailbox down");
    expect(readSchedule(stateRoot).t.running).toBeUndefined();
  });

  it("empty KB with sources requests a full pass immediately; the full pass absorbs the pending incremental", async () => {
    expect((await tickKnowledgeSchedule(deps())).map((x) => x.pass)).toEqual(["full"]);
    expect(mailbox[0].text).toContain("absorbs");
    liveRule("coding.a");
    await ingest();
    clock = at(1);
    fs.appendFileSync(path.join(kbRoot(), "raw", "billing-policy.md"), "\nedit during pass\n");
    expect(completePass("t", { cfg, stateRoot, now: () => clock })).toBe("full");
    const e = readSchedule(stateRoot).t;
    expect(e.lastFullAt).toBe(at(1).toISOString());
    expect(e.running).toBeUndefined();
    // the edit landed after the pass-start snapshot, so it opens the next window
    expect(e.firstChangeAt).toBe(at(1).toISOString());
    expect(e.incrementalDueAt).toBe(at(8).toISOString());
  });

  it("changes absorbed by the pass leave no pending window", async () => {
    liveRule("coding.a");
    schedSeed({ lastFullAt: T0.toISOString(), firstChangeAt: T0.toISOString(), incrementalDueAt: T0.toISOString() });
    await requestPass("t", "full", deps());
    await ingest();
    completePass("t", { cfg, stateRoot, now: () => at(1) });
    const e = readSchedule(stateRoot).t;
    expect(e.firstChangeAt).toBeUndefined();
    expect(changedRefs(kbRoot(), SOURCES)).toEqual([]);
  });
});

function schedSeed(e: Record<string, unknown>) { writeSchedule(stateRoot, { t: { createdAt: T0.toISOString(), ...e } }); }

describe("code-vs-doc (operator decision 2026-10-09)", () => {
  const files = ["src/round.ts"];
  const gitFake = (code: string, doc: string, since = false): GitSeam => ({
    lastCommit: () => ({ rev: "c0de", date: code }),
    changedSince: () => since,
    docDate: () => doc,
  });
  const cc = { project: "flooros", files, summary: "code rounds half-even" };
  const mk = (g: GitSeam) => ctx({ git: g, projects: [{ name: "flooros", root: path.join(root, "flooros") }] });
  const rule = () => loadKbRules(cfg, "t").rules[0];

  it("code newer than doc: never auto-supersedes, escalates with an explanation; operator answer is recorded and not re-asked", () => {
    liveRule("biz.round");
    const c = mk(gitFake("2026-09-01T00:00:00Z", "2026-01-01T00:00:00Z"));
    const dec = { decisions: [{ item: "biz.round", decision: "approve" as const, confidence: 0.99, justification: "x", codeConflict: cc }] };
    const r1 = applyDecisions(dec, c);
    expect(r1.escalated.map((e) => e.key)).toEqual(["code-vs-doc:biz.round"]);
    expect(rule().status).toBe("active");
    const esc = readEscalations(kbRoot())[0];
    expect(esc.explanation).toMatch(/biz\.round.*raw\/billing-policy\.md.*2026-01-01.*src\/round\.ts.*2026-09-01/s);
    expect(esc.needsYou).toBe(true);

    resolveEscalation(c, "code-vs-doc:biz.round", { kind: "verdict", verdict: "keep-doc" }, "operator", "doc is authoritative");
    expect(rule().decision).toMatchObject({ verdict: "keep-doc", by: "operator", reason: "doc is authoritative", codeRev: "c0de" });
    expect(rule().status).toBe("active");
    expect(readEscalations(kbRoot())).toEqual([]);

    // same conflict on the next pass: skipped
    const r2 = applyDecisions(dec, c);
    expect(r2.escalated).toEqual([]);
    expect(readEscalations(kbRoot())).toEqual([]);
  });

  it("re-asks when anchored code changed after the decision, or the doc has a new revision", () => {
    liveRule("biz.round");
    const c = mk(gitFake("2026-09-01T00:00:00Z", "2026-01-01T00:00:00Z"));
    const dec = { decisions: [{ item: "biz.round", decision: "approve" as const, confidence: 0.99, justification: "x", codeConflict: cc }] };
    applyDecisions(dec, c);
    resolveEscalation(c, "code-vs-doc:biz.round", { kind: "verdict", verdict: "keep-doc" }, "op", "r");
    expect(evaluateCodeConflict(mk(gitFake("2026-09-01T00:00:00Z", "2026-01-01T00:00:00Z", true)), rule(), cc).action).toBe("escalate");
    // new doc revision: change the source sha on the rule
    const f = rule().file;
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("abc123abc123abc", "fff999fff999fff"));
    expect(evaluateCodeConflict(mk(gitFake("2026-09-01T00:00:00Z", "2026-01-01T00:00:00Z")), rule(), cc).action).toBe("escalate");
  });

  it("supersede-with-code retires the rule and records the decision", () => {
    liveRule("biz.round");
    const c = mk(gitFake("2026-09-01T00:00:00Z", "2026-01-01T00:00:00Z"));
    applyDecisions({ decisions: [{ item: "biz.round", decision: "approve", confidence: 0.99, justification: "x", codeConflict: cc }] }, c);
    resolveEscalation(c, "code-vs-doc:biz.round", { kind: "verdict", verdict: "supersede-with-code" }, "op", "code is right");
    expect(rule()).toMatchObject({ status: "retired", decision: { verdict: "supersede-with-code" } });
  });

  it("doc newer than code: flagged as a code violation, not escalated", () => {
    liveRule("biz.round");
    const c = mk(gitFake("2026-01-01T00:00:00Z", "2026-09-01T00:00:00Z"));
    const r = applyDecisions({ decisions: [{ item: "biz.round", decision: "approve", confidence: 0.99, justification: "x", codeConflict: cc }] }, c);
    expect(r.violations).toEqual(["biz.round"]);
    const e = readEscalations(kbRoot());
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: "code-violation", needsYou: false });
  });
});

describe("end to end on the #897 golden fixture, through a fake captain mailbox", () => {
  it("request -> reviewer fixture -> always-escalate -> operator -> finish", async () => {
    await ingest();
    applyV1();
    schedSeed({ lastFullAt: T0.toISOString() });

    // 1. the daemon asks the home captain; it does not spawn anything
    const req = await requestPass("t", "incremental", deps());
    expect(req.requested).toBe(true);
    expect(mailbox.map((m) => m.project)).toEqual(["flooros"]);
    expect(mailbox[0].text).toMatch(/knowledge-review/);

    // 2. the reviewer reads the packet and answers (fixture output, no model call)
    const packet = buildReviewPacket(ctx());
    expect(packet.proposals).toHaveLength(1);
    const prop = packet.proposals[0];
    expect(prop.id).toBe("biz.invoice.issue-window-30d");
    expect(prop.priority).toBe("company");
    expect(prop.conflictsWith.map((c) => c.id)).toEqual(["biz.invoice.issue-window"]);
    const res = applyDecisions({ decisions: [{ item: prop.item, decision: "approve", confidence: 0.97, justification: "30d is newer policy" }] }, ctx());

    // 3. high confidence, but company-vs-company conflict on a must rule always escalates
    expect(res.applied).toEqual([]);
    expect(res.escalated[0].reasons).toEqual(expect.arrayContaining(["company-vs-company conflict", "retiring must/must-not"]));
    expect(loadKbRules(cfg, "t").rules.find((r) => r.id === "biz.invoice.issue-window")!.status).toBe("active");
    expect(fs.readdirSync(path.join(kbRulesDir(cfg, "t"), "_proposed")).filter((n) => n.endsWith(".md"))).toHaveLength(1);

    // 4. the pass closes: REPORT.md, schedule advanced, one captain line with the count
    const fin = await finishReconcile("t", deps());
    expect(fin.needsYou).toBe(1);
    expect(fs.readFileSync(path.join(kbRoot(), "REPORT.md"), "utf8")).toContain("Needs you (1)");
    expect(mailbox[mailbox.length - 1]).toEqual({ project: "flooros", text: "t KB: 1 item need you (squadrant knowledge review t)" });
    expect(readSchedule(stateRoot).t.running).toBeUndefined();

    // 5. the operator approves; the new version goes live and retires the conflicting rule
    resolveEscalation(ctx(), prop.item, { kind: "approve" }, "op", "policy changed");
    const after = loadKbRules(cfg, "t").rules;
    expect(after.find((r) => r.id === "biz.invoice.issue-window-30d")).toMatchObject({ status: "active", approvedBy: "human" });
    expect(after.find((r) => r.id === "biz.invoice.issue-window")!.status).toBe("retired");
    expect(readEscalations(kbRoot())).toEqual([]);

    // 6. write-stage audit events and the never-compacted verdicts log
    const names = auditEvents().map((e) => e.event);
    expect(names).toEqual(expect.arrayContaining(["item.approved", "item.applied", "item.superseded"]));
    const verdicts = fs.readFileSync(path.join(kbRoot(), "verdicts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(verdicts.map((v) => v.outcome ?? v.resolution?.kind)).toEqual(["escalated", "approve"]);
  });

  it("auto-applies a confident, non-escalating approval and a reject", async () => {
    await ingest();
    applyV1();
    // drop the conflict link so the proposal is a plain replacement of a should-level rule
    const pdir = path.join(kbRulesDir(cfg, "t"), "_proposed");
    const f = path.join(pdir, fs.readdirSync(pdir).find((n) => n.endsWith(".md"))!);
    const m = matter(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, matter.stringify(m.content, { ...m.data, conflictsWith: [] }));
    const key = path.basename(f, ".md");
    const hi = applyDecisions({ decisions: [{ item: key, decision: "approve", confidence: 0.85, justification: "ok" }] }, ctx());
    expect(hi.applied).toEqual([key]);
    expect(fs.existsSync(f)).toBe(false);
    expect(loadKbRules(cfg, "t").rules.find((r) => r.id === "biz.invoice.issue-window-30d")!.status).toBe("active");
  });

  it("low confidence and reviewer flags escalate", async () => {
    await ingest();
    applyV1();
    const key = buildReviewPacket(ctx()).proposals[0].item;
    const r = applyDecisions({ decisions: [{ item: key, decision: "approve", confidence: 0.5, justification: "unsure", flag: true }] }, ctx());
    expect(r.escalated[0].reasons).toEqual(expect.arrayContaining(["low-confidence", "reviewer-flagged"]));
  });
});

describe("full-pass checks", () => {
  const R = (id: string, kw: string[], domain = "d") => ({ id, domain, status: "active", modality: "should", triggers: { keywords: kw }, sources: [{ ref: "r", sha: "s", quote: "q" }], statement: id, body: id, file: "", layer: "kb:t" }) as never;
  it("dedup candidates share >=2 trigger terms", () => {
    expect(dedupPairs([R("a", ["x", "y"]), R("b", ["y", "x", "z"]), R("c", ["z"])]).map((p) => [p.a, p.b])).toEqual([["a", "b"]]);
  });
  it("usage review: never-surfaced, noisy, violated", () => {
    const ev = [
      ...Array.from({ length: 6 }, () => ({ ts: "2026-10-01T00:00:00Z", itemId: "a", event: "item.surfaced" })),
      ...Array.from({ length: 4 }, () => ({ ts: "2026-10-01T00:00:00Z", itemId: "a", event: "item.outcome", outcome: "noise" })),
      { ts: "2026-10-01T00:00:00Z", itemId: "b", event: "item.outcome", outcome: "violated" },
    ];
    const u = usageReview([R("a", []), R("b", []), R("c", [])], ev);
    expect(u).toMatchObject({ neverSurfaced: ["b", "c"], noisy: ["a"], violated: ["b"] });
  });
  it("domain cap lists the least-surfaced archive candidates", () => {
    const rules = ["a", "b", "c"].map((id) => R(id, []));
    expect(domainCapExcess(rules, 2, { a: 5, b: 0, c: 3 })).toEqual([{ domain: "d", count: 3, cap: 2, candidates: ["b"] }]);
  });
  it("override.base-changed: baseline stamped on first pass, escalated after the KB rule changes", async () => {
    liveRule("coding.o");
    const proj = path.join(kbRoot(), "projects", "flooros", "rules", "coding");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "coding.o.md"), `---\nid: coding.o\ndomain: coding\nmodality: should\nstatus: active\nsources:\n  - { ref: p, sha: s, quote: q }\n---\nOverride.\n`);
    expect(checkOverrides(cfg, "t")).toEqual([]);
    expect(checkOverrides(cfg, "t")[0]).toMatchObject({ changed: false });
    const base = loadKbRules(cfg, "t").rules[0].file;
    fs.writeFileSync(base, fs.readFileSync(base, "utf8").replace("Statement of", "Reworded"));
    expect(checkOverrides(cfg, "t")[0]).toMatchObject({ ruleId: "coding.o", changed: true });
    // finish a full pass: it becomes an escalation
    schedSeed({});
    await finishReconcile("t", { ...deps(), pass: "full", auditDir: path.join(root, "noaudit") });
    expect(readEscalations(kbRoot()).map((e) => e.kind)).toContain("override-base-changed");
    expect(mailbox.at(-1)!.text).toContain("need you");
  });
});

describe("agent proposals", () => {
  it("propose writes to _proposed with agent priority and logs item.proposed", () => {
    const file = proposeAgentRule(ctx(), { statement: "Never log tokens", evidence: "seen in PR 12 review", agent: "claude" });
    expect(file).toContain("_proposed");
    const p = buildReviewPacket(ctx()).proposals[0];
    expect(p.priority).toBe("agent");
    expect(auditEvents().map((e) => e.event)).toContain("item.proposed");
  });
});

describe("offset re-anchoring when a source changes", () => {
  it("still matches the existing rule after text is inserted ahead of it (stored offsets drifted)", async () => {
    await ingest();
    applyV1();
    const ref = "raw/billing-policy.md";
    const raw = path.join(kbRoot(), ref);
    fs.writeFileSync(raw, "A long new preamble paragraph that pushes every later offset forward.\n\n".repeat(5) + fs.readFileSync(raw, "utf8"));
    await ingest();
    const v1 = cands("candidates-v1.json");
    const target = v1.candidates.find((c) => c.source === ref && c.id === "biz.invoice.issue-window")!;
    const res = applyCandidates({ candidates: [{ ...target, id: "model.picked.other-id" }] }, { kb: "t", kbRoot: kbRoot(), rulesDir: kbRulesDir(cfg, "t") });
    expect(res.idOverrides).toEqual([{ from: "model.picked.other-id", to: "biz.invoice.issue-window" }]);
  });
});
