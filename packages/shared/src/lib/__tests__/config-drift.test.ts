import { describe, it, expect } from "vitest";
import { detectDrift, applySafeFixes } from "../config-drift.js";
import { getDefaultConfig } from "../../config.js";

function userConfig() {
  const c = getDefaultConfig();
  c.projects = { brove: { path: "/p", captainName: "x", spokeVault: "/v", host: "local" } };
  c.hubVault = "/Users/me/squadrant-hub";
  c.commandName = "\u{1F3DB}\u{FE0F} command";
  return c;
}

describe("detectDrift \u2014 missing", () => {
  it("flags a managed default key absent from user config", () => {
    const u = userConfig();
    delete (u.defaults as any).worktreeDir;
    const items = detectDrift(u, getDefaultConfig());
    const paths = items.filter((i) => i.kind === "missing").map((i) => i.path);
    expect(paths).toContain("defaults.worktreeDir");
  });

  it("does NOT flag user-data sections as drift", () => {
    const u = userConfig();
    const items = detectDrift(u, getDefaultConfig());
    const paths = items.map((i) => i.path);
    expect(paths.some((p) => p.startsWith("projects"))).toBe(false);
    expect(paths).not.toContain("hubVault");
    expect(paths).not.toContain("commandName");
  });
});

describe("detectDrift \u2014 deprecated", () => {
  it("flags a known-deprecated key present in user config", () => {
    const u = userConfig();
    (u.defaults as any).models = { command: "opus", captain: "opus", crew: "opus", exploration: "haiku", review: "opus" };
    (u.defaults as any).roles = getDefaultConfig().defaults.roles;
    const items = detectDrift(u, getDefaultConfig());
    const dep = items.find((i) => i.kind === "deprecated" && i.path === "defaults.models");
    expect(dep).toBeDefined();
  });

  it("does NOT flag an unknown key it has no opinion about", () => {
    const u = userConfig();
    (u as any).someFutureKey = { a: 1 };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.path === "someFutureKey")).toBe(false);
  });
});

describe("detectDrift \u2014 changed-default", () => {
  it("flags a field whose value equals the OLD default but the default changed", () => {
    const u = userConfig();
    (u.defaults.roles as any).crew = { agent: "claude", model: "opus" };
    const items = detectDrift(u, getDefaultConfig());
    const cd = items.find((i) => i.kind === "changed-default" && i.path === "defaults.roles.crew.model");
    expect(cd).toBeDefined();
    expect(cd?.severity).toBe("advisory");
    expect(cd?.suggested).toBe("sonnet");
  });

  it("does NOT flag a field the user customized to a third value", () => {
    const u = userConfig();
    (u.defaults.roles as any).crew = { agent: "claude", model: "haiku" };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "changed-default" && i.path === "defaults.roles.crew.model")).toBe(false);
  });
});

describe("detectDrift \u2014 invalid", () => {
  it("flags an agent whose driver is not a known driver", () => {
    const u = userConfig();
    (u.agents as any).aider = { cli: "aider", driver: "aider" };
    const items = detectDrift(u, getDefaultConfig());
    const inv = items.find((i) => i.kind === "invalid" && i.path === "agents.aider.driver");
    expect(inv).toBeDefined();
    expect(inv?.severity).toBe("warn");
  });

  it("flags a role whose agent is not present in agents", () => {
    const u = userConfig();
    (u.defaults.roles as any).captain = { agent: "ghost", model: "opus" };
    const items = detectDrift(u, getDefaultConfig());
    const inv = items.find((i) => i.kind === "invalid" && i.path === "defaults.roles.captain.agent");
    expect(inv).toBeDefined();
  });

  it("flags an unknown router kind", () => {
    const u = userConfig();
    (u.defaults as any).router = { kind: "bogus", baseUrl: "https://x.test" };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "invalid" && i.path === "defaults.router.kind")).toBe(true);
  });

  it("flags both apiKey and apiKeyEnv set", () => {
    const u = userConfig();
    (u.defaults as any).router = { kind: "opencode-go", baseUrl: "https://x.test", apiKey: "k", apiKeyEnv: "K" };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "invalid" && i.path === "defaults.router.apiKey")).toBe(true);
  });

  it("flags a non-claude role backend", () => {
    const u = userConfig();
    (u.defaults.roles as any).crew = { agent: "opencode", backend: "proxy" };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "invalid" && i.path === "defaults.roles.crew.backend")).toBe(true);
  });

  it("flags a router backend selected with no defaults.router", () => {
    const u = userConfig();
    (u.defaults.roles as any).crew = { agent: "claude", backend: "proxy" };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "invalid" && i.path === "defaults.roles.crew.backend")).toBe(true);
  });

  it("does NOT seed or flag defaults.router as missing drift", () => {
    const u = userConfig();
    (u.defaults as any).router = { kind: "opencode-go", baseUrl: "https://x.test", apiKey: "k" };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "missing" && i.path.startsWith("defaults.router"))).toBe(false);
    // structural guarantee: the default config never seeds a router block (so --fix cannot add one)
    expect(getDefaultConfig().defaults.router).toBeUndefined();
  });

  it("flags a router baseUrl that is not an absolute URL", () => {
    const u = userConfig();
    (u.defaults as any).router = { kind: "opencode-go", baseUrl: "not-a-url" };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "invalid" && i.path === "defaults.router.baseUrl")).toBe(true);
  });

  it("flags a router port out of range", () => {
    const u = userConfig();
    (u.defaults as any).router = { kind: "opencode-go", baseUrl: "https://x.test", port: 70000 };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "invalid" && i.path === "defaults.router.port")).toBe(true);
  });

  it("flags a model alias that references an unknown agent", () => {
    const u = userConfig();
    (u.defaults as any).router = {
      kind: "opencode-go",
      baseUrl: "https://x.test",
      models: { flash: { upstream: "m", agents: { aider: "a/m" } } },
    };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "invalid" && i.path === "defaults.router.models.flash.agents.aider")).toBe(true);
  });

  it("flags a routing rule with a non-claude backend", () => {
    const u = userConfig();
    (u.defaults as any).router = { kind: "opencode-go", baseUrl: "https://x.test", apiKey: "k" };
    (u.defaults as any).crewRouting = { rules: [{ tier: "x", match: "y", agent: "codex", backend: "proxy" }] };
    const items = detectDrift(u, getDefaultConfig());
    expect(items.some((i) => i.kind === "invalid" && i.path === "defaults.crewRouting.rules.0.backend")).toBe(true);
  });
});

describe("applySafeFixes", () => {
  it("adds missing keys and removes deprecated keys, leaving other drift untouched", () => {
    const u = userConfig();
    delete (u.defaults as any).worktreeDir;
    (u.defaults as any).models = { command: "opus" } as any;
    (u.defaults.roles as any).crew = { agent: "claude", model: "sonnet" };

    const def = getDefaultConfig();
    const items = detectDrift(u, def);
    const { config, applied } = applySafeFixes(u, items, def);

    expect((config.defaults as any).worktreeDir).toBe(def.defaults.worktreeDir);
    expect((config.defaults as any).models).toBeUndefined();
    expect((config.defaults.roles as any).crew.model).toBe("sonnet");
    expect(applied).toContain("defaults.worktreeDir");
    expect(applied).toContain("defaults.models");
    expect(u === config).toBe(false);
  });
});
