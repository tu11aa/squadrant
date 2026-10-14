// Legacy rule refs (migrate-relative `kb/extracted/x.md`, `flooros/CLAUDE.md`) name the same files as the `~/` refs
// sources.yaml declares and ingest writes; every ref comparison must treat both forms as one ref.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, type KnowledgeSourceEntry, type SquadrantConfig } from "@squadrant/shared";
import {
  applyCandidates, findQuote, isGatedRef, loadRulesDir, planIngest, priorityOfRef, removeSource, validateKb,
  type CandidateFile,
} from "../knowledge/index.js";

const CLAUDE_MD = "# Flooros\n\nAlways run the linter before pushing.\n\nKeep commits small.\n";
const LINT = "Always run the linter before pushing.";
const SOURCES = "- path: ~/saitex/kb/extracted/**\n  priority: project\n- path: ~/saitex/flooros/CLAUDE.md\n  priority: company\n- path: raw/**\n  priority: agent\n  review: required\n";

let home: string;
let prevHome: string | undefined;
let kb: string;
let rulesDir: string;

const rule = (id: string, sources: { ref: string; quote?: string; sha?: string; offset?: [number, number] }[], status = "active") => {
  const src = sources.map((s) => `  - ${JSON.stringify({ sha: "abc", quote: "q", ...s })}`).join("\n");
  fs.mkdirSync(path.join(rulesDir, "coding"), { recursive: true });
  fs.writeFileSync(path.join(rulesDir, "coding", `${id}.md`), `---\nid: ${id}\ndomain: coding\nmodality: must\nstatus: ${status}\nsources:\n${src}\n---\nS ${id}.\n`);
};
const byId = () => Object.fromEntries(loadRulesDir(rulesDir, "kb:t").rules.map((r) => [r.id, r]));
const sources = (): KnowledgeSourceEntry[] => [
  { path: "~/saitex/kb/extracted/**", priority: "project" },
  { path: "~/saitex/flooros/CLAUDE.md", priority: "company" },
  { path: "raw/**", priority: "agent", review: "required" },
];

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kb-legacy-home-")));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  kb = path.join(home, "squadrant", "kb", "saitex");
  rulesDir = path.join(kb, "shared", "rules");
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, "sources.yaml"), SOURCES);
  fs.mkdirSync(path.join(home, "saitex", "kb", "extracted"), { recursive: true });
  fs.writeFileSync(path.join(home, "saitex", "kb", "extracted", "coding-rules.md"), "# Coding\n\nq\n");
  fs.writeFileSync(path.join(home, "saitex", "kb", "extracted", "pr-rules.md"), "# PR\n\nq\n");
  fs.mkdirSync(path.join(home, "saitex", "flooros"), { recursive: true });
  fs.writeFileSync(path.join(home, "saitex", "flooros", "CLAUDE.md"), CLAUDE_MD);
});
afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("sources --remove with legacy refs", () => {
  const seed = () => {
    rule("coding.only-extracted", [{ ref: "kb/extracted/coding-rules.md" }]);
    rule("coding.both", [{ ref: "kb/extracted/pr-rules.md" }, { ref: "flooros/CLAUDE.md" }]);
    rule("coding.flooros", [{ ref: "flooros/CLAUDE.md" }]);
  };

  it("matches legacy refs while the files are present", () => {
    seed();
    const r = removeSource(kb, rulesDir, "~/saitex/kb/extracted/**", { dryRun: true });
    expect(r).toMatchObject({ stripped: ["coding.both", "coding.only-extracted"], stale: ["coding.only-extracted"] });
  });

  it("matches legacy refs after the files are gone, and marks extracted-only rules stale", () => {
    seed();
    fs.rmSync(path.join(home, "saitex", "kb", "extracted"), { recursive: true });
    const r = removeSource(kb, rulesDir, "~/saitex/kb/extracted/**");
    expect(r).toMatchObject({ stripped: ["coding.both", "coding.only-extracted"], stale: ["coding.only-extracted"] });
    const rules = byId();
    expect(rules["coding.only-extracted"]).toMatchObject({ status: "stale", sources: [] });
    expect(rules["coding.both"]).toMatchObject({ status: "active" });
    expect(rules["coding.both"].sources.map((s) => s.ref)).toEqual(["flooros/CLAUDE.md"]);
    expect(rules["coding.flooros"].sources.map((s) => s.ref)).toEqual(["flooros/CLAUDE.md"]);
  });

  it("a legacy single-file ref is covered by its ~ entry", () => {
    seed();
    expect(removeSource(kb, rulesDir, "~/saitex/flooros/CLAUDE.md", { dryRun: true }).stripped).toEqual(["coding.both", "coding.flooros"]);
  });
});

describe("isGatedRef with legacy refs", () => {
  const gated = (): KnowledgeSourceEntry[] => [{ path: "~/saitex/kb/extracted/**", priority: "project", review: "required" }];
  it("a legacy-form ref under a gated glob is gated (files present and deleted)", () => {
    expect(isGatedRef(kb, gated(), "kb/extracted/coding-rules.md")).toBe(true);
    fs.rmSync(path.join(home, "saitex", "kb", "extracted"), { recursive: true });
    expect(isGatedRef(kb, gated(), "kb/extracted/coding-rules.md")).toBe(true);
    expect(isGatedRef(kb, gated(), "flooros/CLAUDE.md")).toBe(false);
  });
});

describe("apply with legacy refs", () => {
  const flooros = "~/saitex/flooros/CLAUDE.md";
  const ingest = () => planIngest(kb, { sources: [{ path: flooros, priority: "company" }] });
  const cand = (id: string): CandidateFile => ({ candidates: [
    { source: flooros, id, domain: "coding", modality: "must", statement: `S coding.lint.`, quote: LINT },
  ] });

  it("id-matches by offset and merges a ~ candidate onto a rule citing the legacy ref (one source, not two)", async () => {
    const plan = await ingest();
    expect(plan.sources.map((s) => s.ref)).toEqual([flooros]);
    rule("coding.lint", [{ ref: "flooros/CLAUDE.md", quote: LINT, sha: plan.sources[0].sha, offset: findQuote(CLAUDE_MD, LINT)! }]);
    const r = applyCandidates(cand("coding.model-chose-this"), { kb: "t", kbRoot: kb, rulesDir, sources: sources() });
    expect(r.idOverrides).toEqual([{ from: "coding.model-chose-this", to: "coding.lint" }]);
    expect(r.created).toEqual([]);
    expect(byId()["coding.lint"].sources.map((s) => s.ref)).toEqual([flooros]);
  });

  it("an erratum written with the legacy ref rejects a ~ candidate", async () => {
    await ingest();
    const r = applyCandidates(cand("coding.lint"), {
      kb: "t", kbRoot: kb, rulesDir, sources: sources(),
      errata: [{ id: "flooros.lint", ref: "flooros/CLAUDE.md", quote: LINT, reason: "obsolete" }],
    });
    expect(r.rejected).toEqual([{ id: "coding.lint", source: flooros, reason: "errata:flooros.lint" }]);
    expect(r.orphanedErrata).toEqual([]);
  });

  it("an erratum written with the legacy ref is checked against the ~ ref's converted text (orphan detection)", async () => {
    await ingest();
    const r = applyCandidates(cand("coding.lint"), {
      kb: "t", kbRoot: kb, rulesDir, sources: sources(),
      errata: [{ id: "flooros.gone", ref: "flooros/CLAUDE.md", quote: "a passage no longer in the file", reason: "obsolete" }],
    });
    expect(r.orphanedErrata).toEqual([{ id: "flooros.gone", ref: "flooros/CLAUDE.md" }]);
  });

  it("a complete re-sweep of the ~ ref marks an unmatched rule citing the legacy ref stale", async () => {
    await ingest();
    rule("coding.gone", [{ ref: "flooros/CLAUDE.md", quote: "Keep commits small." }]);
    const r = applyCandidates({ complete: [flooros], candidates: [] }, { kb: "t", kbRoot: kb, rulesDir, sources: sources() });
    expect(r.stale).toEqual(["coding.gone"]);
  });
});

describe("validate and review with legacy refs", () => {
  it("validate warns when a legacy-ref rule is grounded in a ~ erratum", () => {
    rule("coding.lint", [{ ref: "flooros/CLAUDE.md", quote: LINT }]);
    const { checks } = validateKb({
      rulesDir, kbRoot: kb, sources: sources(),
      errata: [{ id: "flooros.lint", ref: "~/saitex/flooros/CLAUDE.md", quote: LINT, reason: "obsolete" }],
    });
    expect(checks.filter((c) => c.level === "warn").map((c) => c.message)).toEqual([expect.stringContaining("grounded in erratum flooros.lint")]);
  });

  it("priorityOfRef finds the declared entry for a legacy ref", () => {
    const cfg: SquadrantConfig = getDefaultConfig();
    cfg.knowledgeBases = { t: { path: kb } };
    const c = { cfg, kb: "t", sources: sources() };
    expect(priorityOfRef(c, "flooros/CLAUDE.md")).toBe("company");
    expect(priorityOfRef(c, "~/saitex/flooros/CLAUDE.md")).toBe("company");
    expect(priorityOfRef(c, "kb/extracted/pr-rules.md")).toBe("project");
  });
});
