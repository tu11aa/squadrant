import { describe, it, expect, vi } from "vitest";
import { createCodexDriver } from "../codex.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === "codex --version") return "codex 1.2.0\n";
    if (cmd.includes("--help")) return "exec  Run a task non-interactively\n";
    return "";
  }),
}));

describe("codex driver", () => {
  const driver = createCodexDriver();

  it("has name 'codex'", () => {
    expect(driver.name).toBe("codex");
    expect(driver.templateSuffix).toBe("generic");
  });

  it("builds command with --json and --full-auto", () => {
    const cmd = driver.buildCommand({
      prompt: "fix the bug",
      workdir: "/tmp/test",
      role: "crew",
      autoApprove: true,
    });
    expect(cmd).toContain("codex exec");
    expect(cmd).toContain("--json");
    expect(cmd).toContain("--full-auto");
  });

  it("probes capabilities", async () => {
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.capabilities).toContain("auto_approve");
    expect(result.capabilities).toContain("json_output");
    expect(result.capabilities).toContain("sandbox");
  });

  it("parses JSONL output", () => {
    const raw = '{"output":"task done"}\n';
    const result = driver.parseOutput(raw);
    expect(result.status).toBe("success");
    expect(result.output).toBe("task done");
  });
});
