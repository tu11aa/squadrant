// KB phase 2a scoring for every domain (#979, spec 2026-10-27 §4.5/§4.6, C4): legacy audit lines are normalized on
// read, `_user` and non-rules domains score, unknown-kb lines are ignored and counted, the dead-domain alarm uses a fixed list.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import {
  auditHealth, auditNormalizer, auditReadCtx, compactAudit, computeScores, finishReconcile, kbDir, knownItems, loadKbItems,
  normalizeAuditRecord, scanCitations, scoreKb, type AuditRecord,
} from "../knowledge/index.js";
import { serializeTrait, type Trait } from "../knowledge/profile.js";
import { computeProfileInjection } from "../knowledge/profile-inject.js";

const NOW = new Date("2026-10-10T00:00:00Z");
let root: string;
let auditDir: string;
let userKb: string;
let cfg: SquadrantConfig;

const project = (name: string, extra: Record<string, unknown> = {}) => ({ path: path.join(root, "repos", name), captainName: name, spokeVault: path.join(root, "spoke"), host: "local", ...extra }) as never;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const rule = (id: string, category = "coding") =>
  `---\nid: ${id}\ndomain: ${category}\nmodality: must\nstatus: active\nsources:\n  - { ref: raw/a.md, sha: s, loc: "L1", quote: q }\n---\nDo ${id}.\n`;
const decision = (id: string, status = "accepted") => `---\nid: ${id}\nstatus: ${status}\nsources: [issue:1]\ncreated: 2026-10-01\nupdated: 2026-10-01\n---\n# ${id}\n\nBody.\n`;
const trait = (id: string) => serializeTrait({ id, domain: "profile", level: "shared", status: "active", kind: "preference", confirmed: true, summary: `Summary ${id}.`,
  audience: "all", tier: "core", sources: [], created: "2026-10-01", updated: "2026-10-01", body: "b\n" } as Trait);
/** One raw audit line, written as-is (legacy shapes included) into the month file. */
const line = (r: Partial<AuditRecord> & { event: string }, day = "2026-10-05") => ({ ts: `${day}T00:00:00Z`, project: "projA", itemId: "coding.a", ...r });
const putLines = (rs: Record<string, unknown>[], month = "2026-10") =>
  fs.appendFileSync(path.join(auditDir, `${month}.m1.jsonl`), rs.map((r) => JSON.stringify(r) + "\n").join(""));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-scores-dom-"));
  auditDir = path.join(root, "audit");
  userKb = path.join(root, "kb", "_user");
  fs.mkdirSync(auditDir, { recursive: true });
  cfg = getDefaultConfig();
  cfg.hubVault = path.join(root, "hub");
  cfg.knowledgeBases = { acme: { path: path.join(root, "kb", "acme") }, globex: { path: path.join(root, "kb", "globex") }, _user: { path: userKb } };
  cfg.groups = { ga: { kb: "acme" }, gn: {} };
  cfg.projects = {
    projA: project("projA", { group: "ga" }), projB: project("projB", { knowledgeHome: "kb:globex" }),
    projR: project("projR", { knowledgeHome: "repo:docs" }), projN: project("projN", { group: "gn" }),
  };
  write(path.join(kbDir(cfg, "acme"), "shared", "rules", "coding", "coding.a.md"), rule("coding.a"));
  write(path.join(kbDir(cfg, "acme"), "shared", "rules", "authz", "authz.never.md"), rule("authz.never", "authz"));
  write(path.join(kbDir(cfg, "acme"), "projects", "projA", "rules", "coding", "coding.proj.md"), rule("coding.proj"));
  write(path.join(kbDir(cfg, "acme"), "shared", "decisions", "dec.db.md"), decision("dec.db"));
  write(path.join(kbDir(cfg, "acme"), "shared", "decisions", "dec.old.md"), decision("dec.old", "superseded"));
  write(path.join(kbDir(cfg, "globex"), "shared", "rules", "coding", "coding.g.md"), rule("coding.g"));
  write(path.join(userKb, "profile", "terse.md"), trait("prof.terse"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("normalizeAuditRecord (legacy lines on read)", () => {
  const n = (r: Partial<AuditRecord>) => normalizeAuditRecord({ ts: "2026-10-05T00:00:00Z", project: "projA", itemId: "x", ...r }, auditReadCtx(cfg));

  it.each([
    ["a rule category in domain → rules + category", { kb: "acme", domain: "coding" }, { kb: "acme", domain: "rules", category: "coding" }],
    ["level group → shared", { kb: "acme", level: "group", domain: "rules" }, { level: "shared", domain: "rules" }],
    ["kb '' with a project → its home KB", { kb: "", project: "projA", domain: "rules" }, { kb: "acme" }],
    ["kb '' of a repo:docs project → repo:<p>", { kb: "", project: "projR", domain: "rules" }, { kb: "repo:projR" }],
    ["kb '' of a project with no home stays '' (the no-home group)", { kb: "", project: "projN", domain: "rules" }, { kb: "" }],
    ["_user profile lines pass", { kb: "_user", domain: "profile" }, { kb: "_user", domain: "profile" }],
    ["a missing domain reads as rules", { kb: "acme" }, { domain: "rules" }],
    ["an explicit category is kept", { kb: "acme", domain: "rules", category: "authz" }, { category: "authz" }],
  ])("%s", (_n, given, want) => expect(n(given)).toMatchObject(want));

  it("drops a kb no config or project has (the kb:'t' test leak)", () => {
    expect(n({ kb: "t", domain: "rules" })).toBeNull();
  });
  it("a non-rules KB domain keeps its domain and gets no category", () => {
    expect(n({ kb: "acme", domain: "decisions" })).not.toHaveProperty("category");
  });
});

describe("scores for every domain", () => {
  const legacyAndNew = () => putLines([
    // rules, pre-#979 shapes: category in domain, level group, kb "" for a project-level rule
    line({ kb: "acme", level: "group", domain: "coding", event: "item.surfaced", chars: 10 }),
    line({ kb: "acme", level: "group", domain: "coding", event: "item.cited" }),
    line({ kb: "", level: "project", domain: "coding", itemId: "coding.proj", event: "item.surfaced" }),
    // new shape
    line({ kb: "acme", level: "shared", domain: "rules", category: "coding", event: "item.surfaced" }),
    line({ kb: "acme", level: "shared", domain: "decisions", itemId: "dec.db", event: "item.shown" }),
    // profile hook
    line({ kb: "_user", level: "shared", domain: "profile", itemId: "prof.terse", event: "item.surfaced", project: "projB" }),
    line({ kb: "_user", level: "shared", domain: "profile", itemId: "prof.terse", event: "item.cited", project: "projB" }),
    // other KB, repo home, no home, test leak
    line({ kb: "globex", level: "shared", domain: "rules", itemId: "coding.g", event: "item.surfaced", project: "projB" }),
    line({ kb: "", level: "project", domain: "coding", itemId: "coding.r", event: "item.surfaced", project: "projR" }),
    line({ kb: "", level: "project", domain: "coding", itemId: "coding.n", event: "item.surfaced", project: "projN" }),
    ...Array.from({ length: 3 }, () => line({ kb: "t", level: "group", domain: "coding", event: "item.surfaced", project: "" })),
  ]);
  const score = (kb: string, known = knownItems(loadKbItems(cfg, kb).items)) =>
    scoreKb({ kb, now: NOW, auditDir, kbRoot: path.join(root, "nokb"), known, normalize: auditNormalizer(cfg) });

  it("legacy lines count under the normalized KB and domain; categories ride on the row", () => {
    legacyAndNew();
    const s = score("acme");
    const item = (id: string) => s.items.find((x) => x.itemId === id)!;
    expect(item("coding.a")).toMatchObject({ domain: "rules", category: "coding", surfaced: 2, cited: 1 });
    expect(item("coding.proj")).toMatchObject({ domain: "rules", surfaced: 1 });
    expect(item("dec.db")).toMatchObject({ domain: "decisions", shown: 1, neverFired30d: true });
    expect(item("authz.never")).toMatchObject({ category: "authz", neverFired30d: true });
    expect(s.items.map((x) => x.itemId)).not.toContain("coding.g");
    expect(s.domains.map((d) => d.domain)).toEqual(["decisions", "rules", "wiki"]);
  });
  it("_user scores its profile domain from the profile hook's events", () => {
    legacyAndNew();
    const s = score("_user");
    expect(s.items).toMatchObject([{ itemId: "prof.terse", domain: "profile", surfaced: 1, cited: 1, useRate: 1 }]);
    expect(s.domains.map((d) => d.domain)).toEqual(["profile"]);
  });
  it("a repo:docs home and the no-home group are scorable (C4)", () => {
    legacyAndNew();
    expect(score("repo:projR", []).items.map((x) => x.itemId)).toEqual(["coding.r"]);
    expect(score("", []).items.map((x) => x.itemId)).toEqual(["coding.n"]);
  });
  it("kb:'t' lines score under no label and are counted by auditHealth", () => {
    legacyAndNew();
    expect(score("t", []).items).toEqual([]);  // and acme's coding.a counted 2, not 5 (first test)
    expect(auditHealth({ cfg, dir: auditDir })).toEqual({ ignored: { t: 3 }, noHome: 1 });
  });
  it("accepted decisions are known-live; superseded ones are not rows", () => {
    const s = computeScores({ kb: "acme", records: [], now: NOW, known: knownItems(loadKbItems(cfg, "acme").items) });
    expect(s.items.filter((x) => x.domain === "decisions").map((x) => [x.itemId, x.neverFired30d])).toEqual([["dec.db", true]]);
  });
  it("an id with only write events still never becomes a row (#964)", () => {
    putLines([line({ kb: "acme", domain: "rules", itemId: "coding.branch-only", event: "item.applied" })]);
    expect(score("acme").items.map((x) => x.itemId)).not.toContain("coding.branch-only");
  });
});

describe("dead-domain alarm over a fixed domain list", () => {
  it("fires for a domain with zero events and zero items in 30 days", () => {
    const s = computeScores({ kb: "acme", now: NOW, records: [{ ts: "2026-10-05T00:00:00Z", kb: "acme", domain: "rules", itemId: "coding.a", event: "item.surfaced" }] });
    expect(s.domains.map((d) => [d.domain, d.deadDomain])).toEqual([["decisions", true], ["rules", false], ["wiki", true]]);
  });
  it("_user alarms on profile only", () => {
    expect(computeScores({ kb: "_user", now: NOW, records: [] }).domains).toMatchObject([{ domain: "profile", deadDomain: true }]);
  });
});

describe("compaction and reconcile read through the normalizer", () => {
  it("legacy lines fold under the normalized KB; a rejected line keeps its raw kb, so nothing is lost", () => {
    putLines([
      line({ kb: "", domain: "coding", itemId: "coding.proj", event: "item.surfaced" }, "2026-07-01"),
      line({ kb: "t", domain: "coding", event: "item.surfaced", project: "" }, "2026-07-01"),
    ], "2026-07");
    expect(compactAudit({ now: NOW, dir: auditDir, normalize: auditNormalizer(cfg) })).toEqual(["2026-07"]);
    const stats = JSON.parse(fs.readFileSync(path.join(auditDir, "2026-07.m1.stats.json"), "utf8"));
    expect(Object.keys(stats.kbs).sort()).toEqual(["acme", "t"]);
    expect(Object.keys(stats.kbs.acme.items)).toEqual(["rules|coding.proj"]);
    expect(scoreKb({ kb: "acme", now: NOW, auditDir, kbRoot: path.join(root, "nokb") }).items.find((x) => x.itemId === "coding.proj")!.lifetimeSurfaced).toBe(1);
  });
  it("finishReconcile scores every domain's known items and counts legacy kb:'' lines", async () => {
    putLines([line({ kb: "", domain: "coding", itemId: "coding.proj", event: "item.surfaced" })]);
    await finishReconcile("acme", { cfg, stateRoot: path.join(root, "state"), enqueue: async () => {}, now: () => NOW, auditDir, log: () => {} });
    const s = JSON.parse(fs.readFileSync(path.join(kbDir(cfg, "acme"), "scores.json"), "utf8"));
    expect(s.items.map((x: { itemId: string }) => x.itemId)).toEqual(["dec.db", "authz.never", "coding.a", "coding.proj"]);  // sorted by domain|id
    expect(s.items.find((x: { itemId: string }) => x.itemId === "coding.proj").surfaced).toBe(1);
  });
});

describe("cite scan for every domain", () => {
  it("a prof.* id in a DONE message after the profile hook surfaced it logs item.cited", () => {
    const sink = { dir: auditDir, now: () => NOW, machineId: "m1" };
    const out = computeProfileInjection({
      cfg, env: { SQUADRANT_USER_KB_DIR: userKb }, cwd: path.join(root, "repos", "projA"), payload: { session_id: "s1" }, agent: "claude", audit: sink, now: () => NOW,
    });
    expect(out).toContain("prof.terse");
    const done = new Date(NOW.getTime() + 60_000);
    expect(scanCitations([{ text: "DONE: kept it short per prof.terse", ref: "crew-done:t1", at: done }], { project: "projA", sink: { ...sink, now: () => done } })).toEqual(["prof.terse"]);
    const cited = fs.readFileSync(path.join(auditDir, "2026-10.m1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event === "item.cited");
    expect(cited).toMatchObject([{ kb: "_user", domain: "profile", level: "shared", project: "projA", itemId: "prof.terse", ref: "crew-done:t1" }]);
  });
});

