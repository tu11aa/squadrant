import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig, threadSessionName } from "@squadrant/shared";
import {
  CapabilityRegistry, buildAgentCmd,
  createClaudeDriver, createCodexDriver, createGeminiDriver, createOpencodeDriver,
} from "@squadrant/agents";
import { threadAgentCommand } from "../thread.js";

const reg = new CapabilityRegistry({
  claude: createClaudeDriver(),
  codex: createCodexDriver(),
  gemini: createGeminiDriver(),
  opencode: createOpencodeDriver(),
});

function setup() {
  const templates = fs.mkdtempSync(path.join(os.tmpdir(), "thread-tpl-"));
  const promptDir = path.join(templates, "threads");
  fs.writeFileSync(path.join(templates, "captain.claude.md"), "captain");
  const config = getDefaultConfig();
  config.defaults.roles = { captain: { agent: "claude", model: "opus[1m]", thinking: "high" } } as typeof config.defaults.roles;
  return { templates, config, promptDir };
}

describe("threadAgentCommand (#1016)", () => {
  it("claude fork = the captain's own command + --resume/--fork-session/--session-id (same prompt-cache prefix)", () => {
    const { templates, config, promptDir } = setup();
    const cmd = threadAgentCommand({ kind: "fork", fromSessionId: "cap-1", sessionId: "thr-1" }, "claude", config, "/repo", promptDir, reg, templates);
    const captain = buildAgentCmd("claude", reg, "captain", true, "auto", "opus[1m]", templates, undefined, undefined, "high");
    const copy = path.join(promptDir, "thread.claude.md");
    expect(cmd).toBe(`claude --resume cap-1 --fork-session --session-id thr-1${captain.slice("claude".length)}`
      .replace(path.join(templates, "captain.claude.md"), copy));
    expect(cmd).toContain("--model opus[1m]");
    // Same system prompt content, but a basename cmux liveness won't classify as a captain.
    expect(cmd).toContain(`--append-system-prompt-file ${copy}`);
    expect(cmd).not.toContain("captain.claude.md");
    expect(fs.readFileSync(copy, "utf-8")).toBe("captain");
    // Captain-only identity flags never leak into a thread.
    expect(cmd).not.toContain("--messaging-socket-path");
    expect(cmd).not.toMatch(/ -n /);
  });

  it("names the thread session itself (-n works with --fork-session), never the captain's name", () => {
    const { templates, config, promptDir } = setup();
    const cmd = threadAgentCommand({ kind: "fork", fromSessionId: "cap-1", sessionId: "thr-1" }, "claude", config, "/repo",
      promptDir, reg, templates, threadSessionName("app", "auth-cache"));
    expect(cmd).toContain(" -n squadrant-thread-app-auth-cache ");
    expect(cmd).not.toContain("squadrant-captain-");
  });

  it("claude resume = --resume <thread session> without fork", () => {
    const { templates, config, promptDir } = setup();
    const cmd = threadAgentCommand({ kind: "resume", sessionId: "thr-1" }, "claude", config, "/repo", promptDir, reg, templates);
    expect(cmd.startsWith("claude --resume thr-1 --permission-mode auto")).toBe(true);
    expect(cmd).not.toContain("--fork-session");
  });

  it("non-claude agents get a plain interactive seed session", () => {
    const { templates, config, promptDir } = setup();
    const oc = threadAgentCommand({ kind: "seed" }, "opencode", config, "/repo", promptDir, reg, templates);
    expect(oc).toMatch(/opencode/);
    expect(oc).not.toMatch(/ run /);
    // codex/gemini drivers build headless one-shots; a thread needs the interactive CLI.
    expect(threadAgentCommand({ kind: "seed" }, "codex", config, "/repo", promptDir, reg, templates)).toBe("codex");
    expect(threadAgentCommand({ kind: "seed" }, "gemini", config, "/repo", promptDir, reg, templates)).toBe("gemini");
  });
});
