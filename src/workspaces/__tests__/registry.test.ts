import { describe, it, expect, vi } from "vitest";
import { WorkspaceRegistry } from "../registry.js";
import type { WorkspaceDriver, WorkspaceScope } from "@cockpit/shared";
import type { CockpitConfig } from "@cockpit/shared";

function stubFactory(name: string): (scope: WorkspaceScope) => WorkspaceDriver {
  return (scope) => ({
    name,
    probe: vi.fn(async () => ({ installed: true, rootExists: true })),
    read: vi.fn(async () => `read:${name}:${scope.root}`),
    write: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    list: vi.fn(async () => []),
    mkdir: vi.fn(async () => {}),
  });
}

function baseConfig(overrides: Partial<CockpitConfig> = {}): CockpitConfig {
  return {
    commandName: "cmd",
    hubVault: "~/hub",
    projects: {},
    defaults: {
      maxCrew: 5,
      worktreeDir: ".worktrees",
      teammateMode: "in-process",
      permissions: { command: "default", captain: "acceptEdits" },
    },
    metrics: { enabled: false, path: "" },
    ...overrides,
  };
}

describe("WorkspaceRegistry", () => {
  it("returns obsidian driver by default for hub", () => {
    const registry = new WorkspaceRegistry({ obsidian: stubFactory("obsidian") });
    const driver = registry.hub(baseConfig());
    expect(driver.name).toBe("obsidian");
  });

  it("uses top-level workspace override for hub", () => {
    const registry = new WorkspaceRegistry({
      obsidian: stubFactory("obsidian"),
      notion: stubFactory("notion"),
    });
    const driver = registry.hub(baseConfig({ workspace: "notion" }));
    expect(driver.name).toBe("notion");
  });

  it("forProject returns obsidian by default", () => {
    const registry = new WorkspaceRegistry({ obsidian: stubFactory("obsidian") });
    const config = baseConfig({
      projects: {
        brove: { path: "/p", captainName: "brove-c", spokeVault: "~/s", host: "local" },
      },
    });
    const driver = registry.forProject("brove", config);
    expect(driver.name).toBe("obsidian");
  });

  it("project-level workspace overrides top-level", () => {
    const registry = new WorkspaceRegistry({
      obsidian: stubFactory("obsidian"),
      notion: stubFactory("notion"),
      plain: stubFactory("plain"),
    });
    const config = baseConfig({
      workspace: "notion",
      projects: {
        brove: { path: "/p", captainName: "brove-c", spokeVault: "~/s", host: "local", workspace: "plain" },
      },
    });
    const driver = registry.forProject("brove", config);
    expect(driver.name).toBe("plain");
  });

  it("throws when configured provider has no factory registered", () => {
    const registry = new WorkspaceRegistry({ obsidian: stubFactory("obsidian") });
    expect(() => registry.hub(baseConfig({ workspace: "unknown" }))).toThrowError(/unknown/i);
  });

  it("forProject throws for unknown project", () => {
    const registry = new WorkspaceRegistry({ obsidian: stubFactory("obsidian") });
    expect(() => registry.forProject("nope", baseConfig())).toThrowError(/not found/i);
  });

  it("hub passes resolved hubVault as scope.root", async () => {
    const registry = new WorkspaceRegistry({ obsidian: stubFactory("obsidian") });
    const driver = registry.hub(baseConfig({ hubVault: "~/cockpit-hub" }));
    const out = await driver.read("x.md");
    expect(out).toMatch(/^read:obsidian:\//);
    expect(out).not.toContain("~");
  });

  it("probeAll returns results keyed by provider name", async () => {
    const registry = new WorkspaceRegistry({
      obsidian: stubFactory("obsidian"),
      notion: stubFactory("notion"),
    });
    const results = await registry.probeAll(baseConfig());
    expect(results.obsidian.installed).toBe(true);
    expect(results.notion.installed).toBe(true);
  });
});
