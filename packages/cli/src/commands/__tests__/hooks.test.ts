import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.SQUADRANT_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "audit-hooks-")); // never write the real audit log
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import { mapHookSub, buildCaptainSessionRecord, rulesHookOutput } from "../hooks.js";

// #560: the "ask-question" sub fires from NativeHookSource's global
// PreToolUse+AskUserQuestion matcher install (see native-hook-source.ts). It
// must extract the SAME real question/options text the crew's own hook set
// does — the previous inline version read a `payload.question` field that
// doesn't exist on Claude's actual PreToolUse payload (tool_name/tool_input),
// so it always fell back to a hardcoded "awaiting input" placeholder.
describe("mapHookSub — ask-question (#560)", () => {
  const TID = "task-abc";

  // task.input.requested — not task.blocked — is the event that carries
  // requestId and drives ctx.schedulePromotion (squadrantd.ts), the
  // answer-routing machinery #562 depends on. It already does everything
  // #560 needs too (state-machine.ts maps it to state 'blocked').
  it("delegates to the real AskUserQuestion extraction — carries the actual question + options + a requestId", () => {
    const payload = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "Which env should I deploy to?", options: [{ label: "staging" }, { label: "prod" }] },
        ],
      },
    };
    const ev = mapHookSub("ask-question", payload, TID);
    expect(ev?.type).toBe("task.input.requested");
    expect(ev).toMatchObject({
      type: "task.input.requested",
      id: TID,
      question: "Which env should I deploy to? (options: staging, prod)",
    });
    expect(typeof (ev as any).requestId).toBe("number");
  });

  it("still fires task.input.requested even with a malformed/missing tool_input — never silently drops the signal", () => {
    const ev = mapHookSub("ask-question", { tool_name: "AskUserQuestion" }, TID);
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("task.input.requested");
  });

  it("other subs still map as before (no regression)", () => {
    expect(mapHookSub("pre-tool-use", {}, TID)).toEqual({ type: "task.progress", id: TID, note: "pre-tool-use" });
    expect(mapHookSub("prompt-submit", {}, TID)).toEqual({ type: "task.first-turn.confirmed", id: TID });
    expect(mapHookSub("unknown-sub", {}, TID)).toBeNull();
  });
});

// #760: permission-request fires from NativeHookSource's global
// PermissionRequest install — a dedicated, earlier, richer permission signal
// than sniffing Notification.message.
describe("mapHookSub — permission-request (#760)", () => {
  const TID = "task-abc";

  it("delegates to mapClaudeHookToEvent PermissionRequest", () => {
    const ev = mapHookSub("permission-request", { tool_name: "Write", tool_input: { file_path: "/tmp/x" } }, TID);
    expect(ev?.type).toBe("task.blocked");
    expect((ev as any).question).toContain("Write");
  });
});

// #763: no source exists today for a crew turn killed by an API error.
describe("mapHookSub — stop-failure (#763)", () => {
  const TID = "task-abc";

  it("delegates to mapClaudeHookToEvent StopFailure", () => {
    const ev = mapHookSub("stop-failure", { error: "529 Overloaded" }, TID);
    expect(ev).toEqual({ type: "task.turn.failed", id: TID, turnId: "hook-stop", error: "529 Overloaded" });
  });
});

// #651: attribution recorded AT THE SOURCE (SessionStart hook), not
// inferred later from file mtimes or transcript content-sniffing — both
// were tried for #650 and both were rejected as unreliable.
describe("buildCaptainSessionRecord (#651)", () => {
  const NOW = "2026-08-03T16:00:00.000Z";

  it("builds a record from a SessionStart payload, preferring payload.transcript_path when present", () => {
    const payload = { session_id: "sess-123", cwd: "/repo", transcript_path: "/repo/.claude/sess-123.jsonl" };
    const record = buildCaptainSessionRecord(payload, "squadrant", "/fallback", NOW);
    expect(record).toEqual({
      sessionId: "sess-123",
      project: "squadrant",
      agent: "claude",
      startedAt: NOW,
      cwd: "/repo",
      transcriptPath: "/repo/.claude/sess-123.jsonl",
    });
  });

  it("derives transcriptPath from session_id + cwd when transcript_path is absent", () => {
    const payload = { session_id: "sess-123", cwd: "/Users/q3labsadmin/me/squadrant" };
    const record = buildCaptainSessionRecord(payload, "squadrant", "/fallback", NOW);
    expect(record?.transcriptPath).toMatch(/-Users-q3labsadmin-me-squadrant\/sess-123\.jsonl$/);
  });

  it("falls back to the given cwd when payload.cwd is missing", () => {
    const payload = { session_id: "sess-123" };
    const record = buildCaptainSessionRecord(payload, "squadrant", "/fallback/cwd", NOW);
    expect(record?.cwd).toBe("/fallback/cwd");
  });

  it("returns null when session_id is missing — nothing meaningful to record", () => {
    expect(buildCaptainSessionRecord({ cwd: "/repo" }, "squadrant", "/fallback", NOW)).toBeNull();
  });

  it("returns null for a malformed/non-object payload", () => {
    expect(buildCaptainSessionRecord(undefined, "squadrant", "/fallback", NOW)).toBeNull();
    expect(buildCaptainSessionRecord("not an object", "squadrant", "/fallback", NOW)).toBeNull();
  });
});

// #899 v0: Rules KB injection rides on the existing session-start /
// prompt-submit subs. It must be purely additive: the lifecycle mapping is
// unchanged and every failure path yields no output.
describe("rulesHookOutput (#899)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-rules-"));
  const projDir = path.join(root, "flooros");
  const ruleDir = path.join(root, "hub", "knowledge", "saitex", "rules", "git");
  fs.mkdirSync(ruleDir, { recursive: true });
  fs.writeFileSync(path.join(ruleDir, "git.branch-naming.md"),
    "---\nid: git.branch-naming\ndomain: coding\nmodality: must\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n"
    + "triggers:\n  keywords: [branch]\n---\nCreate every new branch as feat/<ticket>-<slug>.\n");
  const cfg = (knowledge?: string[]): SquadrantConfig => {
    const c = getDefaultConfig();
    c.hubVault = path.join(root, "hub");
    c.projects = { flooros: { path: projDir, captainName: "f", spokeVault: path.join(root, "spoke"), host: "local", knowledge } };
    return c;
  };
  const opts = (over = {}) => ({ env: {}, cwd: projDir, loadCfg: () => cfg(["saitex"]), stateRoot: path.join(root, "state"), ...over });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("SessionStart → hookSpecificOutput with the must/must-not block", async () => {
    const out = JSON.parse(await rulesHookOutput("session-start", { session_id: "h1" }, opts()));
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("MUST git.branch-naming:");
  });
  it("UserPromptSubmit → matching rule for a strong prompt, nothing for chit-chat", async () => {
    const out = JSON.parse(await rulesHookOutput("prompt-submit", { session_id: "h2", prompt: "create a new branch" }, opts()));
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("git.branch-naming");
    expect(await rulesHookOutput("prompt-submit", { session_id: "h3", prompt: "thanks!" }, opts())).toBe("");
    const notice = "⚠️ Daemon restarted → v0.26.1 (control-plane bounced). Re-verify in-flight crews — a crew mid-first-turn may need a crew send.";
    expect(await rulesHookOutput("prompt-submit", { session_id: "h4", prompt: notice }, opts())).toBe("");
  });
  it("no subscription, env off, other subs → empty", async () => {
    expect(await rulesHookOutput("session-start", {}, opts({ loadCfg: () => cfg() }))).toBe("");
    expect(await rulesHookOutput("session-start", {}, opts({ env: { SQUADRANT_RULES_INJECT: "0" } }))).toBe("");
    expect(await rulesHookOutput("stop", {}, opts())).toBe("");
  });
  it("a throwing config load or a slow lookup → empty, never throws", async () => {
    expect(await rulesHookOutput("session-start", {}, opts({ loadCfg: () => { throw new Error("bad config"); } }))).toBe("");
    const slow = () => { const end = Date.now() + 30; while (Date.now() < end) { /* spin */ } return cfg(["saitex"]); };
    expect(await rulesHookOutput("session-start", {}, opts({ loadCfg: slow, budgetMs: 10 }))).toBe("");
  });
  it("existing lifecycle mapping for the same subs is unchanged", () => {
    expect(mapHookSub("session-start", {}, "t")).toEqual({ type: "task.progress", id: "t", note: "session-start" });
    expect(mapHookSub("prompt-submit", {}, "t")).toEqual({ type: "task.first-turn.confirmed", id: "t" });
  });
});
