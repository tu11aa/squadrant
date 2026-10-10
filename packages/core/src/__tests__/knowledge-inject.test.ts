import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import {
  appendAudit, computeRulesInjection, cleanPromptQuery, isSystemPrompt, formatSessionContext, injectStateDir, kbRulesDir,
  pruneSeenRules, recordSeenRules, readSeenRules, resolveInjectProject, withBudget, type RulesInjectInput,
} from "../knowledge/index.js";

let root: string;
const rule = (id: string, modality: string, body: string, keywords: string[] = []) =>
  `---\nid: ${id}\ndomain: coding\nmodality: ${modality}\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n`
  + (keywords.length ? `triggers:\n  keywords: [${keywords.join(", ")}]\n` : "")
  + `---\n${body}\n`;
function put(id: string, modality: string, body: string, keywords?: string[]) {
  const dir = path.join(kbRulesDir(cfg(), "saitex"), "coding");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), rule(id, modality, body, keywords));
}
function cfg(knowledge: string[] | null = ["saitex"]): SquadrantConfig {
  const c = getDefaultConfig();
  c.hubVault = path.join(root, "hub");
  c.knowledgeBases = { saitex: { path: path.join(root, "kb", "saitex") } };
  c.projects = {
    flooros: { path: path.join(root, "flooros"), captainName: "f", spokeVault: path.join(root, "spoke"), host: "local", knowledge: knowledge ?? undefined },
  };
  return c;
}
const input = (over: Partial<RulesInjectInput>): RulesInjectInput => ({
  event: "session-start", payload: { session_id: "s1" }, cfg: cfg(), env: {},
  cwd: path.join(root, "flooros"), stateRoot: path.join(root, "state"),
  audit: { dir: path.join(root, "audit"), now: () => new Date("2026-10-10T01:02:03Z"), machineId: "m1" }, ...over,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-inject-"));
  put("git.branch-naming", "must", "Create every new branch as feat/<ticket>-<slug> or fix/<ticket>-<slug>.", ["branch", "branches"]);
  put("git.no-force-push", "must-not", "Force-push to main or develop.", ["push", "force"]);
  put("git.commit-format", "must", "Use conventional commit messages.", ["commit"]);
  put("style.prefer-short", "should", "Prefer short functions.", ["function"]);
  put("frontend.verify-live-dom", "must", "Verify UI changes in the live DOM in light and dark mode.", ["ui", "dom", "dark", "light", "verify", "css"]);
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
      "MUST frontend.verify-live-dom: Verify UI changes in the live DOM in light and dark mode.",
      "MUST git.branch-naming: Create every new branch as feat/<ticket>-<slug> or fix/<ticket>-<slug>.",
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
    expect(prompt("create a fix branch please", "d1")).toBeNull();
    expect(prompt("create a fix branch please", "d2")).toContain("git.branch-naming");
  });
  it("rules shown at SessionStart are not re-injected on a prompt", () => {
    computeRulesInjection(input({ payload: { session_id: "ss" } }));
    expect(prompt("create a branch", "ss")).toBeNull();
  });
});

describe("computeRulesInjection — false positives (flooros captain feedback)", () => {
  const prompt = (text: string, session = "fp") =>
    computeRulesInjection(input({ event: "prompt-submit", payload: { session_id: session, prompt: text } }));
  const NOTICE = "⚠️ Daemon restarted → v0.26.1 (control-plane bounced). Re-verify in-flight crews — a crew mid-first-turn may need a crew send.";

  it("the daemon-restart notice injects nothing", () => {
    expect(prompt(NOTICE)).toBeNull();
  });
  it("squadrant notices and peer messages are not human prompts", () => {
    for (const t of [
      NOTICE,
      "CREW DONE [kb-hook]: create a branch and commit",
      "[stale — generated 5m ago] CREW BLOCKED [x]: which branch?",
      "🗒 Side handoff from cmux065: branch naming notes",
      "Another Claude session sent a message:\n<cross-session-message from=\"uds:/x\">create a branch</cross-session-message>",
      "<cross-session-message from=\"uds:/x\">create a branch</cross-session-message>",
    ]) expect(isSystemPrompt(t), t).toBe(true);
    expect(isSystemPrompt("create a branch for the CREW feature")).toBe(false);
    expect(isSystemPrompt("Full task is at /tmp/t.md — cat it and follow it exactly.")).toBe(false);
  });
  it("re-verify / reverify do not hit the verify keyword", () => {
    expect(prompt("please re-verify the light theme", "fp1")).toBeNull();
  });
  it("matches whole words only: 'reverify' and 'ui' inside other words never count", () => {
    expect(prompt("reverify everything", "fp3")).toBeNull();
    expect(prompt("build the guide and the quiz", "fp4")).toBeNull();
  });
  it("a single curated-keyword hit alone is not enough to inject", () => {
    expect(prompt("verify", "fp5")).toBeNull();
    expect(prompt("verify the ui in dark mode", "fp6")).toContain("frontend.verify-live-dom");
  });
  it("a crew first-turn brief pointer is searched through its task file", () => {
    const brief = path.join(root, "task.md");
    fs.writeFileSync(brief, "## Objective\nCreate a new branch and commit the fix.\n");
    const text = prompt(`Full task is at ${brief} — cat it and follow it exactly. --- COMPLETION PROTOCOL (required): run squadrant crew signal done`, "fp7");
    expect(text).toContain("git.branch-naming");
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
  it("does not split prefixed words (re-verify, in-flight, pre-commit)", () => {
    expect(cleanPromptQuery("re-verify in-flight pre-commit")).toBe("re-verify in-flight pre-commit");
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

describe("computeRulesInjection — audit log (#935)", () => {
  const lines = () => {
    const f = path.join(root, "audit", "2026-10.m1.jsonl");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  };
  it("session start logs one surfaced line per rule; output unchanged", () => {
    const text = computeRulesInjection(input({}))!;
    const ev = lines();
    expect(ev).toHaveLength(4);
    expect(ev[0]).toEqual({
      ts: "2026-10-10T01:02:03.000Z", kb: "saitex", level: "group", project: "flooros", domain: "rules",
      itemId: "git.no-force-push", event: "item.surfaced", trigger: "session", chars: "MUST-NOT git.no-force-push: Force-push to main or develop.".length,
      agent: "claude", session: "s1",
    });
    expect(text).toContain("git.no-force-push");
  });
  it("prompt logs surfaced hits with score and suppressed already-seen hits", () => {
    const p = (session: string) => computeRulesInjection(input({ event: "prompt-submit", payload: { session_id: session, prompt: "create a new branch and force push to main" } }));
    p("p1");
    const first = lines().filter((e) => e.trigger === "prompt");
    expect(first.some((e) => e.event === "item.surfaced" && typeof e.score === "number")).toBe(true);
    fs.rmSync(path.join(root, "audit"), { recursive: true });
    p("p1");
    expect(lines().every((e) => e.event === "item.suppressed")).toBe(true);
    expect(lines().length).toBeGreaterThan(0);
  });
  it("never throws on an unwritable path and output is unaffected", () => {
    fs.writeFileSync(path.join(root, "blocker"), "x");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const text = computeRulesInjection(input({ audit: { dir: path.join(root, "blocker", "sub") } }));
    expect(text).toContain("git.branch-naming");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("squadrant audit"));
    err.mockRestore();
  });
});

describe("appendAudit", () => {
  it("truncates query to 200 chars", () => {
    appendAudit([{ kb: "", level: "project", project: "p", domain: "rules", itemId: "", event: "item.searched", query: "q".repeat(500) }],
      { dir: path.join(root, "a2"), now: () => new Date("2026-10-10T00:00:00Z"), machineId: "m" });
    const e = JSON.parse(fs.readFileSync(path.join(root, "a2", "2026-10.m.jsonl"), "utf8"));
    expect(e.query).toHaveLength(200);
  });
});
