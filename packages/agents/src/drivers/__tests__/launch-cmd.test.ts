// Unit tests for buildAgentCmd — no real processes spawned.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapabilityRegistry } from "../registry.js";
import { buildAgentCmd } from "../launch-cmd.js";
import { createClaudeDriver } from "../claude.js";
import type { AgentDriver, AgentProbeResult } from "../types.js";

function mockDriver(name: string, templateSuffix = name): AgentDriver {
  return {
    name,
    templateSuffix,
    probe: vi.fn(async (): Promise<AgentProbeResult> => ({
      installed: true,
      version: "1.0.0",
      capabilities: ["auto_approve"] as any[],
    })),
    buildCommand: vi.fn((opts) => `${name} --prompt "${opts.prompt}"`),
    parseOutput: vi.fn((raw) => ({ status: "success" as const, output: raw })),
    stop: vi.fn(async () => {}),
  };
}

let tmpDir: string;
let templatesDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-launch-cmd-test-"));
  templatesDir = path.join(tmpDir, "templates");
  fs.mkdirSync(templatesDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRegistry(agents: Record<string, AgentDriver>): CapabilityRegistry {
  return new CapabilityRegistry(agents);
}

// ── Claude: fresh vs continue ─────────────────────────────────────────────────

describe("buildAgentCmd — claude driver", () => {
  it("starts fresh with bare 'claude' command", () => {
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto");
    expect(cmd).toMatch(/^claude\b/);
    expect(cmd).not.toContain("-c");
  });

  it("continues with 'claude -c'", () => {
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", false, "auto");
    expect(cmd).toContain("claude -c");
  });

  it("appends --permission-mode acceptEdits", () => {
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "acceptEdits");
    expect(cmd).toContain("--permission-mode acceptEdits");
  });

  it("appends --permission-mode auto", () => {
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto");
    expect(cmd).toContain("--permission-mode auto");
  });

  it("uses --dangerously-skip-permissions for bypassPermissions", () => {
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "bypassPermissions");
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it("appends --model when provided", () => {
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto", "claude-opus-4-8");
    expect(cmd).toContain("--model claude-opus-4-8");
  });

  it("appends --append-system-prompt-file when role template exists", () => {
    const roleFile = path.join(templatesDir, "captain.claude.md");
    fs.writeFileSync(roleFile, "# captain");
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto", undefined, templatesDir);
    expect(cmd).toContain("--append-system-prompt-file");
    expect(cmd).toContain(roleFile);
  });

  it("appends legacy .CLAUDE.md file when .claude.md is absent", () => {
    // On case-sensitive filesystems, .CLAUDE.md is found via the legacy branch.
    // On macOS (case-insensitive), existsSync(".claude.md") finds either casing —
    // the important thing is that the template file IS referenced in the command.
    const legacyFile = path.join(templatesDir, "captain.CLAUDE.md");
    fs.writeFileSync(legacyFile, "# captain legacy");
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto", undefined, templatesDir);
    expect(cmd).toContain("--append-system-prompt-file");
    expect(cmd).toContain(templatesDir);
  });

  it("omits --append-system-prompt-file when no template file exists", () => {
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto", undefined, templatesDir);
    expect(cmd).not.toContain("--append-system-prompt-file");
  });

  it("appends --plugin-dir when plugin dir exists", () => {
    const pluginDir = path.join(templatesDir, "..", "plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto", undefined, templatesDir);
    expect(cmd).toContain("--plugin-dir");
  });
});

// ── Non-Claude agents ─────────────────────────────────────────────────────────

describe("buildAgentCmd — non-claude driver", () => {
  it("delegates to driver.buildCommand", () => {
    const opencode = mockDriver("opencode", "opencode");
    const r = makeRegistry({ opencode });
    buildAgentCmd("opencode", r, "captain", true, "auto");
    expect(opencode.buildCommand).toHaveBeenCalledOnce();
  });

  it("passes autoApprove=true to non-claude driver", () => {
    const codex = mockDriver("codex", "codex");
    const r = makeRegistry({ codex });
    buildAgentCmd("codex", r, "captain", true, "auto");
    const callArgs = (codex.buildCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.autoApprove).toBe(true);
  });

  it("passes model to non-claude driver", () => {
    const gemini = mockDriver("gemini", "gemini");
    const r = makeRegistry({ gemini });
    buildAgentCmd("gemini", r, "captain", true, "auto", "gemini-2.0");
    const callArgs = (gemini.buildCommand as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.model).toBe("gemini-2.0");
  });
});

describe("claude --messaging-socket-path (#667 slice 3)", () => {
  it("emits the flag when a socket path is supplied", () => {
    const cmd = createClaudeDriver().buildCommand({
      prompt: "", workdir: "/tmp/w", role: "crew", interactive: true,
      messagingSocketPath: "/tmp/cc-socks/squadrant-t1.sock",
    });
    expect(cmd).toContain("--messaging-socket-path /tmp/cc-socks/squadrant-t1.sock");
  });

  it("omits the flag entirely when unset — no behaviour change by default", () => {
    const cmd = createClaudeDriver().buildCommand({
      prompt: "", workdir: "/tmp/w", role: "crew", interactive: true,
    });
    expect(cmd).not.toContain("--messaging-socket-path");
  });
  
  it("captain path: buildAgentCmd emits the flag when a path is passed", () => {
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto", undefined, undefined,
      "/tmp/cc-socks/squadrant-captain-demo.sock");
    expect(cmd).toContain("--messaging-socket-path /tmp/cc-socks/squadrant-captain-demo.sock");
  });

  it("captain path: omits the flag when the arg is absent (every existing call site)", () => {
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto");
    expect(cmd).not.toContain("--messaging-socket-path");
  });

  // #697: cmux truncates launchCommand.arguments at --messaging-socket-path
  // when storing it, so anything after it (including the role template flag)
  // is lost and role classification breaks. The flag must come LAST.
  it("places --append-system-prompt-file (and --plugin-dir) before --messaging-socket-path", () => {
    const roleFile = path.join(templatesDir, "captain.claude.md");
    fs.writeFileSync(roleFile, "# captain");
    const pluginDir = path.join(templatesDir, "..", "plugin");
    fs.mkdirSync(pluginDir, { recursive: true });

    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto", undefined, templatesDir,
      "/tmp/cc-socks/squadrant-captain-demo.sock");

    const promptFileIdx = cmd.indexOf("--append-system-prompt-file");
    const pluginDirIdx = cmd.indexOf("--plugin-dir");
    const mspIdx = cmd.indexOf("--messaging-socket-path");
    expect(promptFileIdx).toBeGreaterThan(-1);
    expect(pluginDirIdx).toBeGreaterThan(-1);
    expect(mspIdx).toBeGreaterThan(-1);
    expect(promptFileIdx).toBeLessThan(mspIdx);
    expect(pluginDirIdx).toBeLessThan(mspIdx);
  });

  // #759: assert --messaging-socket-path is literally the last argv token,
  // not just "after" the other flags.
  it("is the last argv token for the captain command", () => {
    const roleFile = path.join(templatesDir, "captain.claude.md");
    fs.writeFileSync(roleFile, "# captain");
    const pluginDir = path.join(templatesDir, "..", "plugin");
    fs.mkdirSync(pluginDir, { recursive: true });

    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto", undefined, templatesDir,
      "/tmp/cc-socks/squadrant-captain-demo.sock");

    const tokens = cmd.trim().split(/\s+/);
    const mspIdx = tokens.indexOf("--messaging-socket-path");
    expect(mspIdx).toBeGreaterThan(-1);
    expect(mspIdx).toBe(tokens.length - 2);
  });
});

// ── thinking level → claude --effort ─────────────────────────────────────────

describe("buildAgentCmd — thinking level", () => {
  it("appends --effort when thinking is set", () => {
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto", "fable", undefined, undefined, undefined, "medium");
    expect(cmd).toContain("--effort medium");
  });

  it("omits --effort when thinking is unset (every existing call site)", () => {
    const r = makeRegistry({ claude: mockDriver("claude") });
    const cmd = buildAgentCmd("claude", r, "captain", true, "auto", "fable");
    expect(cmd).not.toContain("--effort");
  });

  // --effort is claude-only: codex/opencode/gemini reject it, so the flag must
  // never reach the delegate path even when a thinking level is configured.
  it("never forwards --effort to a non-claude driver", () => {
    const opencode = mockDriver("opencode", "opencode");
    const r = makeRegistry({ opencode });
    const cmd = buildAgentCmd("opencode", r, "captain", true, "auto", undefined, undefined, undefined, undefined, "max");
    expect(cmd).not.toContain("--effort");
    expect(opencode.buildCommand).toHaveBeenCalledWith(
      expect.not.objectContaining({ thinking: expect.anything() }),
    );
  });
});
