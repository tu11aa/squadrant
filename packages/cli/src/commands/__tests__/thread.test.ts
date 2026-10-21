import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultConfig } from "@squadrant/shared";
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
  fs.writeFileSync(path.join(templates, "captain.claude.md"), "captain");
  const config = getDefaultConfig();
  config.defaults.roles = { captain: { agent: "claude", model: "opus[1m]", thinking: "high" } } as typeof config.defaults.roles;
  return { templates, config };
}

describe("threadAgentCommand (#1016)", () => {
  it("claude fork = the captain's own command + --resume/--fork-session/--session-id (same prompt-cache prefix)", () => {
    const { templates, config } = setup();
    const cmd = threadAgentCommand({ kind: "fork", fromSessionId: "cap-1", sessionId: "thr-1" }, "claude", config, "/repo", reg, templates);
    const captain = buildAgentCmd("claude", reg, "captain", true, "auto", "opus[1m]", templates, undefined, undefined, "high");
    expect(cmd).toBe(`claude --resume cap-1 --fork-session --session-id thr-1${captain.slice("claude".length)}`);
    expect(cmd).toContain("--model opus[1m]");
    expect(cmd).toContain(`--append-system-prompt-file ${path.join(templates, "captain.claude.md")}`);
    // Captain-only identity flags never leak into a thread.
    expect(cmd).not.toContain("--messaging-socket-path");
    expect(cmd).not.toMatch(/ -n /);
  });

  it("claude resume = --resume <thread session> without fork", () => {
    const { templates, config } = setup();
    const cmd = threadAgentCommand({ kind: "resume", sessionId: "thr-1" }, "claude", config, "/repo", reg, templates);
    expect(cmd.startsWith("claude --resume thr-1 --permission-mode auto")).toBe(true);
    expect(cmd).not.toContain("--fork-session");
  });

  it("non-claude agents get a plain interactive seed session", () => {
    const { templates, config } = setup();
    const cmd = threadAgentCommand({ kind: "seed" }, "opencode", config, "/repo", reg, templates);
    expect(cmd).toMatch(/^.*opencode/);
    expect(cmd).not.toContain("--resume");
  });
});
