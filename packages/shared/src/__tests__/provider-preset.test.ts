import { describe, it, expect } from "vitest";
import {
  PROVIDER_PRESETS,
  isProviderPresetId,
  normalizePresetId,
  detectProviderPresetId,
  providerPresetDefaults,
  applyProviderPreset,
} from "../provider-preset.js";
import { getDefaultConfig, DEFAULT_CREW_ROUTING_RULES, type SquadrantConfig } from "../config.js";

const ALL_ROLES = ["command", "captain", "crew", "exploration", "side"] as const;

describe("provider preset catalog", () => {
  it("lists exactly the three presets a|b|c in order", () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("marks only A as requiring an Anthropic credential", () => {
    expect(PROVIDER_PRESETS.filter((p) => p.requiresAnthropic).map((p) => p.id)).toEqual(["a"]);
  });

  it("validates preset ids", () => {
    expect(isProviderPresetId("a")).toBe(true);
    expect(isProviderPresetId("c")).toBe(true);
    expect(isProviderPresetId("d")).toBe(false);
    expect(isProviderPresetId("e")).toBe(false);
    expect(isProviderPresetId("")).toBe(false);
  });

  it("normalizes the retired preset-C id d to codex's new id c", () => {
    expect(normalizePresetId("a")).toBe("a");
    expect(normalizePresetId("b")).toBe("b");
    expect(normalizePresetId("c")).toBe("c");
    expect(normalizePresetId("d")).toBe("c");
    expect(normalizePresetId("e")).toBeUndefined();
    expect(normalizePresetId("")).toBeUndefined();
  });

  it("detects the existing preset from the configured crew role", () => {
    const base = getDefaultConfig();
    expect(detectProviderPresetId(base)).toBe("a");

    base.defaults.roles = { crew: { agent: "opencode", model: "x" } };
    expect(detectProviderPresetId(base)).toBe("b");

    base.defaults.roles = { crew: { agent: "codex" } };
    expect(detectProviderPresetId(base)).toBe("c");

    // A proxy-backend crew (the retired preset C) has no catalog entry
    // anymore — falls through to the least-surprising default, "a".
    base.defaults.roles = { crew: { agent: "claude", backend: "proxy", model: "x" } };
    expect(detectProviderPresetId(base)).toBe("a");
  });
});

describe("providerPresetDefaults — A (Claude Code Pro/Max)", () => {
  it("assigns every role to claude and auto permissions", () => {
    const d = providerPresetDefaults("a");
    expect(d.roles.command).toEqual({ agent: "claude", model: "opus" });
    expect(d.roles.captain).toEqual({ agent: "claude", model: "opus" });
    expect(d.roles.crew).toEqual({ agent: "claude", model: "sonnet" });
    expect(d.roles.exploration).toEqual({ agent: "claude", model: "haiku" });
    expect(d.roles.side).toEqual({ agent: "claude", model: "opus" });
    expect(d.permissions).toEqual({ command: "auto", captain: "auto", crew: "auto" });
    expect(d.crewRouting.rules).toEqual(DEFAULT_CREW_ROUTING_RULES);
  });
});

describe("providerPresetDefaults — B (opencode)", () => {
  it("assigns every role to opencode with the documented model", () => {
    const d = providerPresetDefaults("b");
    for (const role of ALL_ROLES) {
      expect(d.roles[role]).toEqual({ agent: "opencode", model: "opencode-go/deepseek-v4.1-flash" });
    }
    expect(d.permissions).toEqual({ command: "auto", captain: "auto", crew: "auto" });
    // No tier may resolve back to claude — that would break a non-Anthropic setup.
    expect(d.crewRouting.rules.some((r) => r.agent === "claude")).toBe(false);
    for (const tier of ["extreme", "hard", "daily"]) {
      const rule = d.crewRouting.rules.find((r) => r.tier === tier)!;
      expect(rule.agent).toBe("opencode");
      expect(rule.model).toBe("opencode-go/deepseek-v4.1-flash");
    }
    expect(d.crewRouting.rules.find((r) => r.tier === "mobile")!.agent).toBe("codex");
  });
});

describe("providerPresetDefaults — C (Codex)", () => {
  it("assigns every role to codex and leaves claude permission modes alone, and does not throw", () => {
    expect(() => providerPresetDefaults("c")).not.toThrow();
    const d = providerPresetDefaults("c");
    for (const role of ALL_ROLES) {
      expect(d.roles[role]).toEqual({ agent: "codex" });
    }
    expect(d.permissions).toEqual({});
    expect(d.crewRouting.rules.every((r) => r.agent === "codex")).toBe(true);
    expect(d.crewRouting.rules.every((r) => r.model === undefined)).toBe(true);
  });
});

describe("applyProviderPreset — fresh config (overwrite)", () => {
  it("replaces the default claude roles with preset B and reports the changes", () => {
    const config = getDefaultConfig();
    const { config: next, changes } = applyProviderPreset(config, "b", {
      overwrite: true,
    });
    expect(next.defaults.roles?.crew).toEqual({ agent: "opencode", model: "opencode-go/deepseek-v4.1-flash" });
    expect(next.defaults.permissions).toEqual({ command: "auto", captain: "auto", crew: "auto" });
    expect(changes.length).toBeGreaterThan(0);
  });

  it("replaces the claude-targeted default routing rules for preset B", () => {
    const { config: next, changes } = applyProviderPreset(getDefaultConfig(), "b", { overwrite: true });
    expect(next.defaults.crewRouting?.rules.some((r) => r.agent === "claude")).toBe(false);
    expect(changes).toContain("defaults.crewRouting");
  });

  it("writes codex roles with no permission modes for preset C", () => {
    const config = getDefaultConfig();
    const { config: next } = applyProviderPreset(config, "c", { overwrite: true });
    expect(next.defaults.roles?.crew).toEqual({ agent: "codex" });
    expect(next.defaults.crewRouting?.rules.every((r) => r.agent === "codex")).toBe(true);
  });
});

describe("applyProviderPreset — existing config (re-run-safe)", () => {
  function customConfig(): SquadrantConfig {
    const c = getDefaultConfig();
    c.defaults.roles = { crew: { agent: "opencode", model: "custom-model" } };
    c.defaults.permissions = { command: "auto", captain: "default", crew: "default" };
    c.defaults.effort = "low";
    c.telegram = { supergroupId: 1, chats: [2] };
    c.projects = { demo: { path: "/tmp/demo", captainName: "⚓ demo", spokeVault: "/tmp/v/s", host: "local" } };
    return c;
  }

  it("does not clobber existing roles/permissions when merely re-running", () => {
    const before = customConfig();
    const { config: next, changes } = applyProviderPreset(before, "a", { overwrite: false });
    expect(next.defaults.roles).toEqual(before.defaults.roles);
    expect(next.defaults.permissions).toEqual(before.defaults.permissions);
    expect(next.defaults.crewRouting).toEqual(before.defaults.crewRouting);
    expect(changes).toEqual([]);
  });

  it("fills a wholly-missing roles/permissions block", () => {
    const before = getDefaultConfig() as SquadrantConfig;
    delete (before.defaults as { roles?: unknown }).roles;
    delete (before.defaults as { permissions?: unknown }).permissions;
    const { config: next, changes } = applyProviderPreset(before, "a", { overwrite: false });
    expect(next.defaults.roles?.captain).toEqual({ agent: "claude", model: "opus" });
    expect(next.defaults.permissions.crew).toBe("auto");
    expect(changes).toContain("defaults.roles");
    expect(changes).toContain("defaults.permissions");
  });

  it("never touches unrelated sections (effort, projects, telegram)", () => {
    const before = customConfig();
    const { config: next } = applyProviderPreset(before, "b", { overwrite: false });
    expect(next.defaults.effort).toBe("low");
    expect(next.telegram).toEqual(before.telegram);
    expect(next.projects).toEqual(before.projects);
    expect(next.defaults.maxCrew).toBe(before.defaults.maxCrew);
    // Routing rules are preset-owned — a plain re-run must not rewrite them.
    expect(next.defaults.crewRouting).toEqual(before.defaults.crewRouting);
  });

  it("does not mutate the input config object", () => {
    const before = customConfig();
    const snapshot = JSON.parse(JSON.stringify(before));
    applyProviderPreset(before, "c", { overwrite: false });
    expect(before).toEqual(snapshot);
  });
});
