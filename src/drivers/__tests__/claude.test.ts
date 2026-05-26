import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClaudeDriver } from "../claude.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === "claude --version") return "claude 2.3.0\n";
    return "";
  }),
}));

describe("claude driver", () => {
  const driver = createClaudeDriver();

  it("has name 'claude'", () => {
    expect(driver.name).toBe("claude");
  });

  it("has templateSuffix 'claude'", () => {
    expect(driver.templateSuffix).toBe("claude");
  });

  it("builds basic command", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
    });
    expect(cmd).toContain("claude");
    expect(cmd).toContain("do something");
  });

  it("adds --model flag when model specified", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
      model: "opus",
    });
    expect(cmd).toContain("--model opus");
  });

  it("adds --dangerously-skip-permissions when autoApprove", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
      autoApprove: true,
    });
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it("adds --append-system-prompt-file when promptFile specified", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
      promptFile: "/tmp/captain.claude.md",
    });
    expect(cmd).toContain("--append-system-prompt-file /tmp/captain.claude.md");
  });

  it("adds --settings when settingsPath specified", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
      interactive: true,
      settingsPath: "/tmp/per-crew/settings.json",
    });
    expect(cmd).toContain("--settings /tmp/per-crew/settings.json");
  });

  it("probes and reports capabilities", async () => {
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.version).toContain("2.3.0");
    expect(result.capabilities).toContain("teams");
    expect(result.capabilities).toContain("auto_approve");
    expect(result.capabilities).toContain("json_output");
    expect(result.capabilities).toContain("model_routing");
    expect(result.capabilities).toContain("skills");
    expect(result.capabilities).toContain("prompt_file");
  });

  it("parses JSONL output", () => {
    const raw = '{"type":"progress","content":"working..."}\n{"type":"result","result":"done"}';
    const result = driver.parseOutput(raw);
    expect(result.status).toBe("success");
    expect(result.output).toBe("done");
  });

  it("falls back to raw output when no JSON", () => {
    const raw = "plain text output";
    const result = driver.parseOutput(raw);
    expect(result.status).toBe("success");
    expect(result.output).toBe("plain text output");
  });
});
