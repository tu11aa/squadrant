import { describe, it, expect, vi } from "vitest";
import { createOpencodeDriver } from "../opencode.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === "opencode --version") return "opencode 1.14.50\n";
    return "";
  }),
}));

describe("opencode driver", () => {
  const driver = createOpencodeDriver();

  it("has name 'opencode'", () => {
    expect(driver.name).toBe("opencode");
    expect(driver.templateSuffix).toBe("opencode");
  });

  it("builds command with run, --format json, and -m model", () => {
    const cmd = driver.buildCommand({
      prompt: "explore this",
      workdir: "/tmp/test",
      role: "exploration",
      jsonOutput: true,
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(cmd).toContain('opencode run "explore this"');
    expect(cmd).toContain("--format json");
    expect(cmd).toContain("-m anthropic/claude-sonnet-4-5");
  });

  it("omits --format and -m when not requested", () => {
    const cmd = driver.buildCommand({
      prompt: "hello",
      workdir: "/tmp/test",
      role: "crew",
    });
    expect(cmd).toBe('opencode run "hello"');
  });

  it("escapes quotes in prompt", () => {
    const cmd = driver.buildCommand({
      prompt: 'say "hi"',
      workdir: "/tmp/test",
      role: "crew",
    });
    expect(cmd).toContain('\\"hi\\"');
  });

  it("buildCommand interactive returns bare opencode", () => {
    const cmd = driver.buildCommand({
      prompt: "first turn — delivered via runtime.send later",
      workdir: "/tmp/test",
      role: "crew",
      interactive: true,
      jsonOutput: true,
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(cmd).toBe("opencode");
  });

  it("buildCommand interactive with a port binds the embedded server", () => {
    const cmd = driver.buildCommand({
      prompt: "first turn",
      workdir: "/tmp/test",
      role: "crew",
      interactive: true,
      port: 54321,
    });
    expect(cmd).toBe("opencode --port 54321");
  });

  it("probes capabilities", async () => {
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.capabilities).toContain("auto_approve");
    expect(result.capabilities).toContain("json_output");
    expect(result.capabilities).toContain("streaming");
    expect(result.capabilities).toContain("model_routing");
  });

  it("parses JSON output", () => {
    const raw = '{"response":"found it"}';
    const result = driver.parseOutput(raw);
    expect(result.status).toBe("success");
    expect(result.output).toBe("found it");
  });

  it("falls back to raw text", () => {
    const raw = "plain response text";
    const result = driver.parseOutput(raw);
    expect(result.status).toBe("success");
    expect(result.output).toBe("plain response text");
  });
});
