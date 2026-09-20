import { describe, it, expect } from "vitest";
import {
  PROVIDER_PRESETS,
  isProviderPresetId,
  detectProviderPresetId,
  providerPresetDefaults,
  applyProviderPreset,
} from "../provider-preset.js";
import {
  getDefaultConfig,
  DEFAULT_CREW_ROUTING_RULES,
  type RouterConfig,
  type SquadrantConfig,
} from "../config.js";

const ROUTER: RouterConfig = {
  kind: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go",
  apiKeyEnv: "OPENCODE_API_KEY",
};

const ALL_ROLES = ["command", "captain", "crew", "exploration", "side"] as const;

describe("provider preset catalog", () => {
  it("lists exactly the four presets a|b|c|d in order", () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("marks only A as requiring an Anthropic credential", () => {
    expect(PROVIDER_PRESETS.filter((p) => p.requiresAnthropic).map((p) => p.id)).toEqual(["a"]);
  });

  it("validates preset ids", () => {
    expect(isProviderPresetId("a")).toBe(true);
    expect(isProviderPresetId("d")).toBe(true);
    expect(isProviderPresetId("e")).toBe(false);
    expect(isProviderPresetId("")).toBe(false);
  });

  it("detects the existing preset from the configured crew role", () => {
    const base = getDefaultConfig();
    expect(detectProviderPresetId(base)).toBe("a");

    base.defaults.roles = { crew: { agent: "opencode", model: "x" } };
    expect(detectProviderPresetId(base)).toBe("b");

    base.defaults.roles = { crew: { agent: "codex" } };
    expect(detectProviderPresetId(base)).toBe("d");

    base.defaults.roles = { crew: { agent: "claude", backend: "proxy", model: "x" } };
    expect(detectProviderPresetId(base)).toBe("c");
  });
});

describe("providerPresetDefaults — A (Claude Code Pro/Max)", () => {
  it("assigns every role to claude and auto permissions, no router/gate", () => {
    const d = providerPresetDefaults("a");
    expect(d.roles.command).toEqual({ agent: "claude", model: "opus" });
    expect(d.roles.captain).toEqual({ agent: "claude", model: "opus" });
    expect(d.roles.crew).toEqual({ agent: "claude", model: "sonnet" });
    expect(d.roles.exploration).toEqual({ agent: "claude", model: "haiku" });
    expect(d.roles.side).toEqual({ agent: "claude", model: "opus" });
    expect(d.permissions).toEqual({ command: "auto", captain: "auto", crew: "auto" });
    expect(d.router).toBeUndefined();
    expect(d.gate).toBeUndefined();
    expect(d.crewRouting.rules).toEqual(DEFAULT_CREW_ROUTING_RULES);
  });
});

describe("providerPresetDefaults — B (opencode)", () => {
  it("assigns every role to opencode with the documented model, no router/gate", () => {
    const d = providerPresetDefaults("b");
    for (const role of ALL_ROLES) {
      expect(d.roles[role]).toEqual({ agent: "opencode", model: "opencode-go/deepseek-v4.1-flash" });
    }
    expect(d.permissions).toEqual({ command: "auto", captain: "auto", crew: "auto" });
    expect(d.router).toBeUndefined();
    expect(d.gate).toBeUndefined();
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

describe("providerPresetDefaults — C (claude harness + router)", () => {
  it("routes every claude role through the proxy backend and enables the gate", () => {
    const d = providerPresetDefaults("c", ROUTER);
    for (const role of ALL_ROLES) {
      expect(d.roles[role]?.agent).toBe("claude");
      expect(d.roles[role]?.backend).toBe("proxy");
      expect(d.roles[role]?.model).toBe(d.roles.crew?.model);
    }
    expect(d.router).toEqual(ROUTER);
    expect(d.gate).toEqual({ mode: "on" });
    // Auto mode fails closed on a router backend — the gate replaces it.
    expect(d.permissions.captain).toBe("default");
    expect(d.permissions.crew).toBe("default");
    // Every claude rule must carry the proxy backend — a native claude rule
    // would demand an Anthropic credential the operator does not have.
    for (const rule of d.crewRouting.rules) {
      if (rule.agent === "claude") {
        expect(rule.backend).toBe("proxy");
        expect(rule.model).toBe("deepseek-v4.1-flash");
      }
    }
    expect(d.crewRouting.rules.find((r) => r.tier === "extreme")!.agent).toBe("claude");
    expect(d.crewRouting.rules.find((r) => r.tier === "hard")!.agent).toBe("claude");
    expect(d.crewRouting.rules.find((r) => r.tier === "daily")!.agent).toBe("opencode");
    expect(d.crewRouting.rules.find((r) => r.tier === "mobile")!.agent).toBe("codex");
  });

  it("throws a clear error when no router config is supplied", () => {
    expect(() => providerPresetDefaults("c")).toThrow(/router/i);
  });
});

describe("providerPresetDefaults — D (Codex)", () => {
  it("assigns every role to codex and leaves claude permission modes alone", () => {
    const d = providerPresetDefaults("d");
    for (const role of ALL_ROLES) {
      expect(d.roles[role]).toEqual({ agent: "codex" });
    }
    expect(d.router).toBeUndefined();
    expect(d.gate).toBeUndefined();
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
    expect(next.defaults.router).toBeUndefined();
    expect(next.defaults.gate).toBeUndefined();
    expect(changes.length).toBeGreaterThan(0);
  });

  it("writes router + gate + default permission mode for preset C", () => {
    const config = getDefaultConfig();
    const { config: next } = applyProviderPreset(config, "c", { router: ROUTER, overwrite: true });
    expect(next.defaults.router).toEqual(ROUTER);
    expect(next.defaults.gate).toEqual({ mode: "on" });
    expect(next.defaults.permissions.captain).toBe("default");
    expect(next.defaults.permissions.crew).toBe("default");
    expect(next.defaults.roles?.captain?.backend).toBe("proxy");
  });

  it("leaves router/gate absent for preset B", () => {
    const config = getDefaultConfig();
    const { config: next } = applyProviderPreset(config, "b", { overwrite: true });
    expect("router" in next.defaults).toBe(false);
    expect("gate" in next.defaults).toBe(false);
  });

  it("replaces the claude-targeted default routing rules for preset B", () => {
    const { config: next, changes } = applyProviderPreset(getDefaultConfig(), "b", { overwrite: true });
    expect(next.defaults.crewRouting?.rules.some((r) => r.agent === "claude")).toBe(false);
    expect(changes).toContain("defaults.crewRouting");
  });
});

describe("applyProviderPreset — existing config (re-run-safe)", () => {
  function customConfig(): SquadrantConfig {
    const c = getDefaultConfig();
    c.defaults.roles = { crew: { agent: "opencode", model: "custom-model" } };
    c.defaults.permissions = { command: "auto", captain: "default", crew: "default" };
    c.defaults.router = ROUTER;
    c.defaults.gate = { mode: "on" };
    c.defaults.effort = "low";
    c.telegram = { supergroupId: 1, chats: [2] };
    c.projects = { demo: { path: "/tmp/demo", captainName: "⚓ demo", spokeVault: "/tmp/v/s", host: "local" } };
    return c;
  }

  it("does not clobber existing roles/router/gate when merely re-running", () => {
    const before = customConfig();
    const { config: next, changes } = applyProviderPreset(before, "a", { overwrite: false });
    expect(next.defaults.roles).toEqual(before.defaults.roles);
    expect(next.defaults.router).toEqual(ROUTER);
    expect(next.defaults.gate).toEqual({ mode: "on" });
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
    applyProviderPreset(before, "c", { router: ROUTER, overwrite: false });
    expect(before).toEqual(snapshot);
  });
});
