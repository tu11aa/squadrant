import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendAudit, compactAudit, computeScores, scanAndLogCitations, scoreKb, renderScoresSection, mentionsId, appendVerdict, type AuditEvent, type AuditRecord } from "../knowledge/index.js";

const NOW = new Date("2026-10-10T00:00:00Z");
const rec = (day: string, e: Partial<AuditRecord> & { event: string }): AuditRecord =>
  ({ ts: `${day}T00:00:00Z`, kb: "saitex", project: "flooros", domain: "rules", itemId: "r.a", ...e });

describe("computeScores (table-driven)", () => {
  const records: AuditRecord[] = [
    rec("2026-10-01", { event: "item.surfaced", chars: 100, agent: "claude", trigger: "prompt" }),
    rec("2026-10-02", { event: "item.surfaced", chars: 100, agent: "claude", trigger: "session" }),
    rec("2026-10-03", { event: "item.surfaced", chars: 100, agent: "opencode", trigger: "prompt" }),
    rec("2026-10-03", { event: "item.surfaced", chars: 100, agent: "claude", trigger: "prompt" }),
    rec("2026-10-04", { event: "item.shown" }),
    rec("2026-10-05", { event: "item.cited" }),
    rec("2026-10-05", { event: "item.cited" }),
    rec("2026-10-06", { event: "item.outcome", outcome: "noise" }),
    rec("2026-10-07", { event: "item.outcome", outcome: "violated" }),
    rec("2026-10-08", { event: "item.suppressed" }),
    // a second rule that only fired outside the window
    rec("2026-08-01", { event: "item.surfaced", itemId: "r.old", chars: 50, agent: "claude" }),
    // other domain: writes only
    rec("2026-10-02", { event: "item.proposed", domain: "decisions", itemId: "d.x" }),
  ];
  const s = computeScores({
    kb: "saitex", records, now: NOW,
    known: [{ id: "r.a", domain: "rules", status: "active" }, { id: "r.old", domain: "rules", status: "active" }, { id: "r.never", domain: "rules", status: "active" }, { id: "r.retired", domain: "rules", status: "retired" }],
  });
  const item = (id: string) => s.items.find((x) => x.itemId === id)!;

  it.each([
    ["fire rate", () => item("r.a").fireRate, 4],
    ["pull rate", () => item("r.a").pullRate, 1],
    ["use rate = cited / surfaced", () => item("r.a").useRate, 0.5],
    ["noise rate", () => item("r.a").noiseRate, 0.25],
    ["violation rate", () => item("r.a").violationRate, 0.25],
    ["suppressed", () => item("r.a").suppressed, 1],
    ["last surfaced", () => item("r.a").lastSurfaced, "2026-10-03T00:00:00Z"],
    ["last used", () => item("r.a").lastUsed, "2026-10-05T00:00:00Z"],
    ["fired earlier but not in 30d is never-fired", () => item("r.old").neverFired30d, true],
    ["its lifetime count is kept", () => item("r.old").lifetimeSurfaced, 1],
    ["an item with no events is never-fired", () => item("r.never").neverFired30d, true],
    ["use rate is null with nothing surfaced", () => item("r.never").useRate, null],
    ["retired rule is not a known item", () => s.items.some((x) => x.itemId === "r.retired"), false],
    ["per-agent coverage", () => s.perAgentCoverage, { claude: 3, opencode: 1 }],
    ["tier contribution (falls back to trigger)", () => s.tierContribution, { prompt: 3, session: 1 }],
    ["domain reads/month", () => s.domains.find((d) => d.domain === "rules")!.readsPerMonth, 5],
    ["domain writes/month", () => s.domains.find((d) => d.domain === "decisions")!.writesPerMonth, 1],
    ["chars per citation", () => s.domains.find((d) => d.domain === "rules")!.charsPerCitation, 200],
    ["active domain is not dead", () => s.domains.find((d) => d.domain === "decisions")!.deadDomain, false],
  ])("%s", (_n, got, want) => expect(got()).toEqual(want));

  it("a domain with no activity in 30 days raises the dead-domain alarm", () => {
    const dead = computeScores({ kb: "saitex", records: [rec("2026-08-01", { event: "item.surfaced", domain: "wiki", itemId: "w" })], now: NOW, known: [{ id: "w", domain: "wiki", status: "active" }] });
    expect(dead.domains.find((d) => d.domain === "wiki")!.deadDomain).toBe(true);
  });
  it("reviewer agreement = operator approvals / operator resolutions", () => {
    const v = computeScores({ kb: "k", records: [], now: NOW, verdicts: [
      { kind: "review", item: "a", outcome: "escalated" },
      { kind: "operator", resolution: { kind: "approve" } }, { kind: "operator", resolution: { kind: "reject" } }, { kind: "operator", resolution: { kind: "approve" } },
    ] });
    expect(v.reviewerAgreement).toEqual({ resolved: 3, approved: 2, rate: 0.667 });
  });
  it("REPORT section carries counts and ids, never prompt text", () => {
    const text = renderScoresSection(s).join("\n");
    expect(text).toContain("## Scores (30 days)");
    expect(text).toContain("| r.a | 4 | 1 | 2 | 50% | 25% | 25% |");
    expect(text).toContain("Never fired (2): r.never, r.old");
    expect(text).toContain("claude 3, opencode 1");
  });
});

describe("compaction and citations", () => {
  let dir: string;
  const sink = (now = NOW) => ({ dir, now: () => now, machineId: "m1" });
  const ev = (over: Partial<AuditEvent> = {}): AuditEvent => ({ kb: "saitex", level: "group", project: "flooros", domain: "rules", itemId: "git.no-force-push", event: "item.surfaced", ...over });
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-scores-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("folds months older than the scoring window into stats and keeps the totals", () => {
    appendAudit([ev({ chars: 10 }), ev({ event: "item.cited" })], sink(new Date("2026-07-15T00:00:00Z")));
    appendAudit([ev()], sink(new Date("2026-09-25T00:00:00Z")));  // inside the 30d window: stays raw
    appendAudit([ev()], sink(new Date("2026-10-05T00:00:00Z")));
    expect(compactAudit({ now: NOW, dir })).toEqual(["2026-07"]);
    expect(fs.readdirSync(dir).sort()).toEqual(["2026-07.m1.stats.json", "2026-09.m1.jsonl", "2026-10.m1.jsonl"]);
    const s = scoreKb({ kb: "saitex", now: NOW, auditDir: dir, kbRoot: path.join(dir, "kb") });
    const it = s.items.find((x) => x.itemId === "git.no-force-push")!;
    expect(it.lifetimeSurfaced).toBe(3);   // 1 compacted + 2 raw
    expect(it.surfaced).toBe(2);           // window is 2026-09-10..: the Sep 25 and Oct 5 events
    expect(it.lastUsed).toBe("2026-07-15T00:00:00.000Z");
  });
  it("compaction never touches verdicts.jsonl and is idempotent", () => {
    const kbRoot = path.join(dir, "kb");
    appendVerdict(kbRoot, { kind: "review", item: "x", outcome: "applied" }, new Date("2026-06-01T00:00:00Z"));
    const before = fs.readFileSync(path.join(kbRoot, "verdicts.jsonl"), "utf8");
    appendAudit([ev()], sink(new Date("2026-06-01T00:00:00Z")));
    compactAudit({ now: NOW, dir });
    expect(compactAudit({ now: NOW, dir })).toEqual([]);
    expect(fs.readFileSync(path.join(kbRoot, "verdicts.jsonl"), "utf8")).toBe(before);
  });

  it("mentionsId matches whole tokens only", () => {
    expect(mentionsId("applied git.no-force-push, thanks", "git.no-force-push")).toBe(true);
    expect(mentionsId("git.no-force-push-extra", "git.no-force-push")).toBe(false);
    expect(mentionsId("xgit.no-force-push", "git.no-force-push")).toBe(false);
  });
  it("cites only ids delivered to the project, once per ref, and narrows to the session", () => {
    appendAudit([ev({ session: "s1" }), ev({ itemId: "git.other", session: "s2" })], sink(new Date("2026-10-09T00:00:00Z")));
    const text = "Followed git.no-force-push and git.other and git.unseen";
    expect(scanAndLogCitations({ text, ref: "crew-done:1", project: "flooros", session: "s1", sink: sink() })).toEqual(["git.no-force-push"]);
    expect(scanAndLogCitations({ text, ref: "crew-done:1", project: "flooros", sink: sink() })).toEqual(["git.other"]);
    expect(scanAndLogCitations({ text, ref: "crew-done:1", project: "flooros", sink: sink() })).toEqual([]);
    expect(scanAndLogCitations({ text, ref: "crew-done:1", project: "elsewhere", sink: sink() })).toEqual([]);
    const lines = fs.readFileSync(path.join(dir, "2026-10.m1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.event === "item.cited").map((l) => [l.itemId, l.ref])).toEqual([["git.no-force-push", "crew-done:1"], ["git.other", "crew-done:1"]]);
  });
  it("ignores deliveries after the text was written", () => {
    appendAudit([ev()], sink(new Date("2026-10-09T00:00:00Z")));
    expect(scanAndLogCitations({ text: "git.no-force-push", ref: "r", project: "flooros", at: new Date("2026-10-08T00:00:00Z"), sink: sink() })).toEqual([]);
  });
});
