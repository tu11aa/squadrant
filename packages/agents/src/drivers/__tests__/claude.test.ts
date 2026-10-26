import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("adds --permission-mode when permissionMode specified", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
      permissionMode: "acceptEdits",
    });
    expect(cmd).toContain("--permission-mode acceptEdits");
  });

  it("omits --permission-mode when permissionMode not specified", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
    });
    expect(cmd).not.toContain("--permission-mode");
  });

  it("points --plugin-dir at the crew-scoped subset for role crew", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
    });
    expect(cmd).toContain("/.config/squadrant/plugin-crew");
  });

  it("points --plugin-dir at the full plugin dir for non-crew roles", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "command",
    });
    expect(cmd).toContain("/.config/squadrant/plugin");
    expect(cmd).not.toContain("plugin-crew");
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

describe("claude driver — thinking level", () => {
  const driver = createClaudeDriver();

  it("adds --effort flag when thinking specified", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
      thinking: "medium",
    });
    expect(cmd).toContain("--effort medium");
  });

  it("omits --effort entirely when thinking is unset", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
      model: "opus",
    });
    expect(cmd).not.toContain("--effort");
  });
});

describe("claude driver — #759 --messaging-socket-path ordering", () => {
  const driver = createClaudeDriver();

  // #697/#759: cmux <=0.64.18 truncates launchCommand.arguments at
  // --messaging-socket-path when storing it, so anything after it (like
  // --plugin-dir) is lost. It must be the last argv token for interactive
  // sessions, matching the captain/command path (launch-cmd.ts).
  it("is the last argv token for an interactive crew command", () => {
    const cmd = driver.buildCommand({
      prompt: "do something",
      workdir: "/tmp/test",
      role: "crew",
      interactive: true,
      messagingSocketPath: "/tmp/cc-socks/squadrant-crew-demo.sock",
    });
    const tokens = cmd.trim().split(/\s+/);
    const mspIdx = tokens.indexOf("--messaging-socket-path");
    expect(mspIdx).toBeGreaterThan(-1);
    expect(mspIdx).toBe(tokens.length - 2);
    expect(cmd).toContain("--plugin-dir");
    expect(cmd.indexOf("--plugin-dir")).toBeLessThan(cmd.indexOf("--messaging-socket-path"));
  });

  describe("#1046 isolated SQUADRANT_CONFIG", () => {
    const saved = process.env.SQUADRANT_CONFIG;
    afterEach(() => {
      if (saved === undefined) delete process.env.SQUADRANT_CONFIG;
      else process.env.SQUADRANT_CONFIG = saved;
    });

    it("swaps the user settings source for the isolated settings file, before --messaging-socket-path", () => {
      process.env.SQUADRANT_CONFIG = "/tmp/sq-dev/config.json";
      const cmd = driver.buildCommand({
        prompt: "x", workdir: "/tmp/test", role: "crew", interactive: true,
        messagingSocketPath: "/tmp/s.sock",
      });
      expect(cmd).toContain(" --setting-sources project,local --settings '/tmp/sq-dev/claude-settings.json'");
      expect(cmd.indexOf("--settings")).toBeLessThan(cmd.indexOf("--messaging-socket-path"));
    });

    it("refuses a routed --settings file under an isolated config", () => {
      process.env.SQUADRANT_CONFIG = "/tmp/sq-dev/config.json";
      expect(() => driver.buildCommand({ prompt: "x", workdir: "/tmp/test", role: "crew", settingsPath: "/tmp/r.json" })).toThrow(/#1046/);
    });

    it("default config adds no flags", () => {
      delete process.env.SQUADRANT_CONFIG;
      expect(driver.buildCommand({ prompt: "x", workdir: "/tmp/test", role: "crew" })).not.toContain("--setting-sources");
    });
  });
});

describe("claude driver — launch-time init prompt", () => {
  const driver = createClaudeDriver();
  const base = {
    prompt: "ignored for interactive",
    workdir: "/tmp/test",
    role: "crew",
    interactive: true,
    messagingSocketPath: "/tmp/cc-socks/squadrant-x.sock",
  } as const;

  it("passes --session-id, --add-dir=, and the init file as the last (shell-expanded) arg", () => {
    const cmd = driver.buildCommand({
      ...base,
      sessionId: "0b1c2d3e-0000-4000-8000-000000000001",
      initPromptFile: "/state/p/t1/init.md",
      addDirs: ["/state/p/t1/brief"],
    });
    expect(cmd).toContain(" --session-id 0b1c2d3e-0000-4000-8000-000000000001");
    // `=` form: `--add-dir <dir>` is variadic and would swallow the prompt.
    expect(cmd).toContain(" --add-dir='/state/p/t1/brief'");
    expect(cmd.endsWith(` --messaging-socket-path /tmp/cc-socks/squadrant-x.sock "$(cat '/state/p/t1/init.md')"`)).toBe(true);
  });

  it("side session: the init file is the last arg, with no socket or session id (launch positional)", () => {
    const cmd = driver.buildCommand({
      prompt: "topic", workdir: "/w", role: "side", interactive: true,
      initPromptFile: "/state/p/side/s1/init.md",
    });
    expect(cmd.endsWith(` "$(cat '/state/p/side/s1/init.md')"`)).toBe(true);
    expect(cmd).not.toContain("--messaging-socket-path");
    expect(cmd).not.toContain("--session-id");
    expect(cmd).not.toContain(" -p ");
  });

  it("single-quotes init paths with spaces and quotes", () => {
    const cmd = driver.buildCommand({ ...base, initPromptFile: "/a b/it's/init.md" });
    expect(cmd).toContain(`"$(cat '/a b/it'\\''s/init.md')"`);
  });

  it("is unchanged without an init file (no positional prompt, no session id)", () => {
    const cmd = driver.buildCommand({ ...base });
    expect(cmd).not.toContain("$(cat");
    expect(cmd).not.toContain("--session-id");
    expect(cmd.trim().endsWith("--messaging-socket-path /tmp/cc-socks/squadrant-x.sock")).toBe(true);
  });
});
