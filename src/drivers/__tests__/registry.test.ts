import { describe, it, expect, vi } from "vitest";
import { CapabilityRegistry } from "../registry.js";
import type { AgentDriver, AgentProbeResult } from "../types.js";

function mockDriver(name: string, capabilities: string[], installed = true): AgentDriver {
  return {
    name,
    templateSuffix: name === "claude" ? "claude" : "generic",
    probe: vi.fn(async (): Promise<AgentProbeResult> => ({
      installed,
      version: "1.0.0",
      capabilities: capabilities as any[],
    })),
    buildCommand: vi.fn(() => `${name} run`),
    parseOutput: vi.fn((raw) => ({ status: "success" as const, output: raw })),
    stop: vi.fn(async () => {}),
  };
}

describe("CapabilityRegistry", () => {
  it("probes all registered drivers on init", async () => {
    const claude = mockDriver("claude", ["auto_approve", "teams", "json_output", "model_routing", "skills"]);
    const codex = mockDriver("codex", ["auto_approve", "json_output", "sandbox"]);
    const registry = new CapabilityRegistry({ claude, codex });
    await registry.probeAll();
    expect(claude.probe).toHaveBeenCalledOnce();
    expect(codex.probe).toHaveBeenCalledOnce();
  });

  it("returns driver by name", async () => {
    const claude = mockDriver("claude", ["auto_approve"]);
    const registry = new CapabilityRegistry({ claude });
    await registry.probeAll();
    expect(registry.getDriver("claude")).toBe(claude);
  });

  it("throws for unknown agent", async () => {
    const registry = new CapabilityRegistry({});
    await registry.probeAll();
    expect(() => registry.getDriver("unknown")).toThrow("No driver registered for agent 'unknown'");
  });

  it("validates required capabilities — blocks when missing", async () => {
    const gemini = mockDriver("gemini", ["model_routing"]);
    const registry = new CapabilityRegistry({ gemini });
    await registry.probeAll();
    const result = registry.validateRole("gemini", "command");
    expect(result.allowed).toBe(false);
    expect(result.missingRequired).toContain("auto_approve");
  });

  it("validates preferred capabilities — warns when missing", async () => {
    const codex = mockDriver("codex", ["auto_approve", "json_output", "sandbox"]);
    const registry = new CapabilityRegistry({ codex });
    await registry.probeAll();
    const result = registry.validateRole("codex", "captain");
    expect(result.allowed).toBe(true);
    expect(result.missingPreferred).toContain("teams");
  });

  it("validates — passes when all capabilities present", async () => {
    const claude = mockDriver("claude", ["auto_approve", "teams", "json_output", "model_routing", "skills"]);
    const registry = new CapabilityRegistry({ claude });
    await registry.probeAll();
    const result = registry.validateRole("claude", "captain");
    expect(result.allowed).toBe(true);
    expect(result.missingRequired).toEqual([]);
    expect(result.missingPreferred).toEqual([]);
  });

  it("skips uninstalled agents", async () => {
    const missing = mockDriver("missing", [], false);
    const registry = new CapabilityRegistry({ missing });
    await registry.probeAll();
    const result = registry.validateRole("missing", "crew");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not installed");
  });

  it("lists installed agents", async () => {
    const claude = mockDriver("claude", ["auto_approve"]);
    const codex = mockDriver("codex", ["auto_approve"], false);
    const registry = new CapabilityRegistry({ claude, codex });
    await registry.probeAll();
    const installed = registry.installedAgents();
    expect(installed).toEqual(["claude"]);
  });
});
