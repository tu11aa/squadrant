import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.SQUADRANT_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "audit-hooks-")); // never write the real audit log
import { getDefaultConfig, type SquadrantConfig } from "@squadrant/shared";
import { mapHookSub, buildCaptainSessionRecord, rulesHookOutput, profileHookOutput, preToolUseGuard, attributionGuard, PROFILE_HOOK_SUB } from "../hooks.js";
import { serializeTrait } from "@squadrant/core";

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
  const ruleDir = path.join(root, "kb", "saitex", "shared", "rules", "git");
  fs.mkdirSync(ruleDir, { recursive: true });
  fs.writeFileSync(path.join(ruleDir, "git.branch-naming.md"),
    "---\nid: git.branch-naming\ndomain: coding\nmodality: must\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n"
    + "triggers:\n  keywords: [branch]\n---\nCreate every new branch as feat/<ticket>-<slug>.\n");
  const cfg = (knowledge?: string[]): SquadrantConfig => {
    const c = getDefaultConfig();
    c.hubVault = path.join(root, "hub");
    c.knowledgeBases = { saitex: { path: path.join(root, "kb", "saitex") } };
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
  it("PostToolUse(Read) → rules whose glob matches the file; other tools and files → nothing (#899)", async () => {
    const d = path.join(root, "kb", "saitex", "shared", "rules", "sol");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "sol.no-unchecked.md"),
      "---\nid: sol.no-unchecked\ndomain: coding\nmodality: must-not\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n"
      + "triggers:\n  globs: ['contracts/**/*.sol']\n---\nUse unchecked arithmetic.\n");
    const read = (file: string, tool = "Read", session = "r1") =>
      rulesHookOutput("post-tool-use", { session_id: session, tool_name: tool, tool_input: { file_path: file } }, opts());
    const out = JSON.parse(await read(path.join(projDir, "contracts", "vault", "Vault.sol")));
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("MUST-NOT sol.no-unchecked:");
    expect(await read(path.join(projDir, "contracts", "vault", "Vault.sol"))).toBe("");
    expect(await read(path.join(projDir, "src", "a.ts"), "Read", "r2")).toBe("");
    expect(await read(path.join(projDir, "contracts", "A.sol"), "Edit", "r3")).toBe("");
    expect(mapHookSub("post-tool-use", {}, "t")).toBeNull();
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

// #900: codex / gemini / opencode adapters call the same core; only the sub names, the hookEventName
// echoed back, the read-tool shape and the audit `agent` differ.
describe("rulesHookOutput — codex / gemini / opencode adapters (#900)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-rules-agents-"));
  const projDir = path.join(root, "flooros");
  const ruleDir = path.join(root, "kb", "saitex", "shared", "rules", "sol");
  fs.mkdirSync(ruleDir, { recursive: true });
  fs.writeFileSync(path.join(ruleDir, "sol.no-unchecked.md"),
    "---\nid: sol.no-unchecked\ndomain: coding\nmodality: must-not\nstatus: active\nsources:\n  - { ref: r, sha: s, quote: q }\n"
    + "triggers:\n  globs: ['contracts/**/*.sol']\n  keywords: [vault]\n---\nUse unchecked arithmetic in vault code.\n");
  const cfg = (): SquadrantConfig => {
    const c = getDefaultConfig();
    c.hubVault = path.join(root, "hub");
    c.knowledgeBases = { saitex: { path: path.join(root, "kb", "saitex") } };
    c.projects = { flooros: { path: projDir, captainName: "f", spokeVault: path.join(root, "spoke"), host: "local", knowledge: ["saitex"] } };
    return c;
  };
  const run = (agent: string, sub: string, payload: unknown) =>
    rulesHookOutput(sub, payload, { env: {}, cwd: projDir, loadCfg: cfg, stateRoot: path.join(root, "state"), agent });
  const audited = () => fs.readdirSync(process.env.SQUADRANT_AUDIT_DIR!)
    .flatMap((f) => fs.readFileSync(path.join(process.env.SQUADRANT_AUDIT_DIR!, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as { agent?: string; itemId: string; event: string });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("codex: UserPromptSubmit + PostToolUse(shell cat) inject; audit agent=codex", async () => {
    const p = JSON.parse(await run("codex", "prompt-submit", { session_id: "cx1", prompt: "edit contracts/vault/Vault.sol" }));
    expect(p.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(p.hookSpecificOutput.additionalContext).toContain("sol.no-unchecked");
    const r = JSON.parse(await run("codex", "post-tool-use", { session_id: "cx2", tool_name: "Bash", tool_input: { command: "cat contracts/vault/Vault.sol" } }));
    expect(r.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(r.hookSpecificOutput.additionalContext).toContain("MUST-NOT sol.no-unchecked");
    expect(await run("codex", "post-tool-use", { session_id: "cx3", tool_name: "Bash", tool_input: { command: "cat a.sol | grep x" } })).toBe("");
    expect(audited().some((e) => e.agent === "codex" && e.itemId === "sol.no-unchecked" && e.event === "item.surfaced")).toBe(true);
  });
  it("gemini: BeforeAgent + AfterTool(read_file); audit agent=gemini", async () => {
    const b = JSON.parse(await run("gemini", "before-agent", { session_id: "g1", prompt: "edit contracts/vault/Vault.sol" }));
    expect(b.hookSpecificOutput.hookEventName).toBe("BeforeAgent");
    expect(b.hookSpecificOutput.additionalContext).toContain("sol.no-unchecked");
    const a = JSON.parse(await run("gemini", "after-tool", { session_id: "g2", tool_name: "read_file", tool_input: { file_path: path.join(projDir, "contracts/A.sol") } }));
    expect(a.hookSpecificOutput.hookEventName).toBe("AfterTool");
    expect(audited().some((e) => e.agent === "gemini" && e.event === "item.surfaced")).toBe(true);
  });
  it("opencode: chat-message + tool-after; audit agent=opencode", async () => {
    const c = JSON.parse(await run("opencode", "chat-message", { session_id: "o1", prompt: "edit contracts/vault/Vault.sol" }));
    expect(c.hookSpecificOutput.additionalContext).toContain("sol.no-unchecked");
    const t = JSON.parse(await run("opencode", "tool-after", { session_id: "o2", tool_name: "read", tool_input: { filePath: path.join(projDir, "contracts/B.sol") } }));
    expect(t.hookSpecificOutput.additionalContext).toContain("sol.no-unchecked");
    expect(audited().some((e) => e.agent === "opencode" && e.event === "item.surfaced")).toBe(true);
  });
  it("a sub that belongs to another agent injects nothing", async () => {
    expect(await run("gemini", "prompt-submit", { session_id: "x", prompt: "edit contracts/vault/Vault.sol" })).toBe("");
    expect(await run("codex", "chat-message", { session_id: "x", prompt: "edit contracts/vault/Vault.sol" })).toBe("");
  });
});

describe("profileHookOutput (#982)", () => {
  const ukb = fs.mkdtempSync(path.join(os.tmpdir(), "ukb-hooks-"));
  fs.mkdirSync(path.join(ukb, "profile"), { recursive: true });
  fs.writeFileSync(path.join(ukb, "profile", "a.md"), serializeTrait({ id: "prof.a", domain: "profile", level: "shared", status: "active", kind: "preference",
    confirmed: true, summary: "Lead with a proposal.", audience: "all", tier: "core", sources: [], created: "2026-10-15", updated: "2026-10-15", body: "" }));
  // A project with a rules KB, so a rules leak would be visible.
  const cfg = getDefaultConfig();
  const loadCfg = () => cfg;
  const env = { SQUADRANT_USER_KB_DIR: ukb };

  it("is the profile-session-start sub", () => expect(PROFILE_HOOK_SUB).toBe("profile-session-start"));
  for (const [agent, name] of [["claude", "SessionStart"], ["codex", "SessionStart"], ["gemini", "SessionStart"], ["opencode", "session"]] as const) {
    it(`${agent}: outputs only the profile block as its own additionalContext (${name})`, async () => {
      const out = JSON.parse(await profileHookOutput({ session_id: "s" }, { env, cwd: "/tmp", agent, loadCfg }));
      expect(out.hookSpecificOutput.hookEventName).toBe(name);
      const ctx: string = out.hookSpecificOutput.additionalContext;
      expect(ctx.startsWith("<squadrant-operator-profile>")).toBe(true);
      expect(ctx.trim().endsWith("</squadrant-operator-profile>")).toBe(true);
      expect(ctx).toContain("[prof.a] Lead with a proposal.");
      expect(ctx).not.toMatch(/squadrant-project-rules|Rules KB:/);
    });
  }
  it("fail-open: a missing _user, a throwing config or a blown budget give empty output", async () => {
    expect(await profileHookOutput({}, { env: { SQUADRANT_USER_KB_DIR: path.join(ukb, "nope") }, cwd: "/tmp", loadCfg })).toBe("");
    expect(await profileHookOutput({}, { env, cwd: "/tmp", loadCfg: () => { throw new Error("bad config"); } })).toBe("");
    expect(await profileHookOutput({}, { env, cwd: "/tmp", loadCfg, budgetMs: -1 })).toBe("");
    expect(await profileHookOutput({}, { env: { ...env, SQUADRANT_PROFILE_INJECT: "0" }, cwd: "/tmp", loadCfg })).toBe("");
  });
});

describe("preToolUseGuard passes the _user path to the #556 guard (#982 review)", () => {
  const crew = { SQUADRANT_CREW_TASK_ID: "t1", SQUADRANT_CREW_PROJECT: "p" };
  const write = (file_path: string) => ({ tool_name: "Write", tool_input: { file_path } });
  it("uses knowledgeBases._user.path from config", () => {
    const cfg = getDefaultConfig();
    cfg.knowledgeBases = { _user: { path: "/kb/me" } };
    expect(preToolUseGuard(write("/kb/me/profile/x.md"), crew, "/Users/q", () => cfg).decision).toBe("deny");
    expect(preToolUseGuard(write("/kb/other/x.md"), crew, "/Users/q", () => cfg).decision).toBe("allow");
  });
  it("uses SQUADRANT_USER_KB_DIR, and still guards when the config cannot load", () => {
    const env = { ...crew, SQUADRANT_USER_KB_DIR: "/kb/env" };
    expect(preToolUseGuard(write("/kb/env/profile/x.md"), env, "/Users/q", () => { throw new Error("bad config"); }).decision).toBe("deny");
  });
  it("a captain session is never denied", () => {
    expect(preToolUseGuard(write("/kb/env/profile/x.md"), { SQUADRANT_USER_KB_DIR: "/kb/env" }, "/Users/q", () => getDefaultConfig()).decision).toBe("allow");
  });
});

describe("attributionGuard wiring (#1004)", () => {
  const homeWith = (settings: string) => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "attrib-hook-"));
    fs.mkdirSync(path.join(h, ".claude"));
    fs.writeFileSync(path.join(h, ".claude", "settings.json"), settings);
    return h;
  };
  const commit = { tool_name: "Bash", tool_input: { command: 'git commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"' } };
  it("denies for any session when attribution is disabled in settings.json", () => {
    const r = attributionGuard(commit, homeWith('{"attribution":{"commit":""}}'));
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/Co-Authored-By: Claude/);
  });
  it("allows when attribution is not disabled, or settings are unreadable", () => {
    expect(attributionGuard(commit, homeWith("{}")).decision).toBe("allow");
    expect(attributionGuard(commit, fs.mkdtempSync(path.join(os.tmpdir(), "attrib-none-"))).decision).toBe("allow");
  });
  it("ignores non-Bash payloads", () => {
    expect(attributionGuard({ tool_name: "Write", tool_input: {} }, homeWith('{"attribution":{"commit":""}}')).decision).toBe("allow");
    expect(attributionGuard(undefined, "/nonexistent").decision).toBe("allow");
  });
});
