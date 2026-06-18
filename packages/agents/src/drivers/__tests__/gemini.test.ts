import { describe, it, expect, vi } from "vitest";
import { createGeminiDriver } from "../gemini.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === "gemini --version") return "gemini 0.4.0\n";
    return "";
  }),
}));

describe("gemini driver", () => {
  const driver = createGeminiDriver();

  it("has name 'gemini'", () => {
    expect(driver.name).toBe("gemini");
    expect(driver.templateSuffix).toBe("generic");
  });

  it("builds command with -p and --yolo", () => {
    const cmd = driver.buildCommand({
      prompt: "explore this",
      workdir: "/tmp/test",
      role: "exploration",
      autoApprove: true,
      jsonOutput: true,
    });
    expect(cmd).toContain("gemini -p");
    expect(cmd).toContain("--yolo");
    expect(cmd).toContain("--output-format json");
  });

  it("probes capabilities", async () => {
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.capabilities).toContain("auto_approve");
    expect(result.capabilities).toContain("json_output");
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
