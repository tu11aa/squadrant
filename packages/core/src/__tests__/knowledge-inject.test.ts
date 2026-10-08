import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import {
  computeRulesInjection, cleanPromptQuery, formatSessionContext, injectStateDir, kbRulesDir,
  pruneSeenRules, recordSeenRules, readSeenRules, resolveInjectProject, withBudget, type RulesInjectInput,
} from "../knowledge/index.js";

let root: string;
const rule = (id: string, modality: string, body: string, keywords: string[] = []) =>
  `---\nid: ${id}\ndomain: coding\nmodality: ${modality}\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n`
  + (keywords.length ? `triggers:\n  keywords: [${keywords.join(", ")}]\n` : "")
  + `---\n${body}\n`;
function put(id: string, modality: string, body: string, keywords?: string[]) {
  const dir = path.join(kbRulesDir(path.join(root, "hub"), "saitex"), "coding");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), rule(id, modality, body, keywords));
}
function cfg(knowledge: string[] | null = ["saitex"]): SquadrantConfig {
  const c = getDefaultConfig();
  c.hubVault = path.join(root, "hub");
  c.projects = {
    flooros: { path: path.join(root, "flooros"), captainName: "f", spokeVault: path.join(root, "spoke"), host: "local", knowledge: knowledge ?? undefined },
  };
  return c;
}
const input = (over: Partial<RulesInjectInput>): RulesInjectInput => ({
  event: "session-start", payload: { session_id: "s1" }, cfg: cfg(), env: {},
  cwd: path.join(root, "flooros"), stateRoot: path.join(root, "state"), ...over,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-inject-"));
  put("git.branch-naming", "must", "Name branches feat/<ticket>-<slug>.", ["branch", "branches"]);
  put("git.no-force-push", "must-not", "Force-push to main or develop.", ["push", "force"]);
  put("git.commit-format", "must", "Use conventional commit messages.", ["commit"]);
  put("style.prefer-short", "should", "Prefer short functions.", ["function"]);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("computeRulesInjection — off switches", () => {
  it("no KB subscription → no output", () => {
    expect(computeRulesInjection(input({ cfg: cfg(null) }))).toBeNull();
    expect(computeRulesInjection(input({ cfg: cfg([]) }))).toBeNull();
  });
  it("cwd outside any project → no output", () => {
    expect(computeRulesInjection(input({ cwd: "/elsewhere" }))).toBeNull();
  });
  it("SQUADRANT_RULES_INJECT=0 → no output", () => {
    expect(computeRulesInjection(input({ env: { SQUADRANT_RULES_INJECT: "0" } }))).toBeNull();
  });
});

describe("computeRulesInjection — SessionStart", () => {
  it("emits a labelled data block with every active must/must-not rule, must-not first", () => {
    const text = computeRulesInjection(input({}))!;
    expect(text).toContain('<squadrant-project-rules kb="saitex">');
    expect(text).toContain("not instructions to run anything");
    const lines = text.split("\n");
    const ruleLines = lines.filter((l) => /^MUST/.test(l));
    expect(ruleLines).toEqual([
      "MUST-NOT git.no-force-push: Force-push to main or develop.",
      "MUST git.branch-naming: Name branches feat/<ticket>-<slug>.",
      "MUST git.commit-format: Use conventional commit messages.",
    ]);
    expect(text).not.toContain("style.prefer-short");
    expect(text).toContain("squadrant rules search");
    expect(text).toContain("rules-ops");
  });
  it("caps the list and points at rules list --brief", () => {
    const { text, ids } = formatSessionContext(["saitex"], [
      { id: "a.one", modality: "must", status: "active", statement: "One.", layer: "kb:saitex" },
      { id: "a.two", modality: "must", status: "active", statement: "Two.", layer: "kb:saitex" },
      { id: "a.three", modality: "must-not", status: "active", statement: "Three.", layer: "kb:saitex" },
    ] as never, 2);
    expect(ids).toEqual(["a.three", "a.one"]);
    expect(text).toContain("+1 more: squadrant rules list --brief");
  });
  it("resolves a crew worktree under the project path, and SQUADRANT_CREW_PROJECT", () => {
    const wt = path.join(root, "flooros", ".worktrees", "crew-x");
    expect(computeRulesInjection(input({ cwd: wt }))).toContain("git.branch-naming");
    expect(computeRulesInjection(input({ cwd: "/elsewhere", env: { SQUADRANT_CREW_PROJECT: "flooros" } }))).toContain("git.branch-naming");
    expect(resolveInjectProject(cfg(), "/elsewhere", {}, "flooros")).toBe("flooros");
    expect(resolveInjectProject(cfg(), path.join(root, "flooros-other"), {})).toBeNull();
  });
  it("payload.cwd wins over the process cwd", () => {
    expect(computeRulesInjection(input({ cwd: "/elsewhere", payload: { session_id: "s1", cwd: path.join(root, "flooros") } })))
      .toContain("git.branch-naming");
  });
});

describe("computeRulesInjection — UserPromptSubmit", () => {
  const prompt = (text: string, session = "p1") =>
    computeRulesInjection(input({ event: "prompt-submit", payload: { session_id: session, prompt: text } }));

  it("strong prompt → at most 3 matching rules in a labelled block", () => {
    const text = prompt("create a new branch for the invoice fix and commit it")!;
    expect(text).toContain('<squadrant-project-rules match="prompt">');
    expect(text).toContain("MUST git.branch-naming:");
    expect(text.split("\n").filter((l) => /^(MUST|SHOULD|MAY)/.test(l)).length).toBeLessThanOrEqual(3);
  });
  it("weak or chit-chat prompt → nothing", () => {
    for (const p of ["hi", "thanks!", "how are you doing today?", "ok sounds good, go ahead", "what time is it", ""]) {
      expect(prompt(p)).toBeNull();
    }
  });
  it("dedups across two prompts in the same session, not across sessions", () => {
    expect(prompt("create a branch", "d1")).toContain("git.branch-naming");
    expect(prompt("rename the branch please", "d1")).toBeNull();
    expect(prompt("rename the branch please", "d2")).toContain("git.branch-naming");
  });
  it("rules shown at SessionStart are not re-injected on a prompt", () => {
    computeRulesInjection(input({ payload: { session_id: "ss" } }));
    expect(prompt("create a branch", "ss")).toBeNull();
  });
});

describe("cleanPromptQuery", () => {
  it("drops code fences, long pasted lines, urls, stopwords and short tokens", () => {
    const q = cleanPromptQuery("Please fix the branch!\n```\nconst secretThing = 1\n```\n" + "x".repeat(500) + "\nsee https://example.com/foo and open a PR");
    expect(q).toBe("fix branch open pr");
  });
  it("adds the parts of hyphen/dot tokens and drops rule-meta words", () => {
    expect(cleanPromptQuery("list the branch-naming rule and any must-not rules")).toBe("list branch-naming branch naming");
  });
});

describe("dedup store", () => {
  it("records, reads back, and prunes week-old files", () => {
    const st = path.join(root, "state");
    recordSeenRules(st, "a/b", ["x", "y"]);
    recordSeenRules(st, "a/b", ["y", "z"]);
    expect([...readSeenRules(st, "a/b")].sort()).toEqual(["x", "y", "z"]);
    pruneSeenRules(st, Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(fs.readdirSync(injectStateDir(st))).toEqual([]);
  });
});

describe("withBudget", () => {
  it("returns the value within budget", async () => {
    expect(await withBudget(() => "ok", 100)).toBe("ok");
  });
  it("a throw → null", async () => {
    expect(await withBudget(() => { throw new Error("boom"); }, 100)).toBeNull();
  });
  it("a timeout → null", async () => {
    expect(await withBudget(() => new Promise<string>((r) => setTimeout(() => r("late"), 200)), 20)).toBeNull();
  });
  it("a sync overrun → null", async () => {
    expect(await withBudget(() => { const end = Date.now() + 40; while (Date.now() < end) { /* spin */ } return "late"; }, 20)).toBeNull();
  });
});
