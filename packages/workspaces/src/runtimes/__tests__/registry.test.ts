import { describe, it, expect, vi } from "vitest";
import { RuntimeRegistry } from "../registry.js";
import type { RuntimeDriver } from "../types.js";
import type { SquadrantConfig } from "@squadrant/shared";

function stubDriver(name: string): RuntimeDriver {
  return {
    name,
    probe: vi.fn(async () => ({ installed: true, version: `${name} 1.0` })),
    list: vi.fn(async () => []),
    status: vi.fn(async () => null),
    spawn: vi.fn(async () => ({ id: "workspace:1", name: "x", status: "running" as const })),
    send: vi.fn(async () => {}),
    sendKey: vi.fn(async () => {}),
    readScreen: vi.fn(async () => ""),
    stop: vi.fn(async () => {}),
    newPane: vi.fn(async () => ({ workspaceId: "workspace:1", surfaceId: "surface:1" })),
    closePane: vi.fn(async () => {}),
    sendToPane: vi.fn(async () => {}),
    pasteToPane: vi.fn(async () => {}),
    sendKeyToPane: vi.fn(async () => {}),
    readPaneScreen: vi.fn(async () => ""),
    listSurfaces: vi.fn(async () => []),
    spawnInjector: vi.fn(async () => ({ workspaceId: "workspace:1", surfaceId: "surface:1" })),
    sendToSurface: vi.fn(async () => {}),
  };
}

function baseConfig(overrides: Partial<SquadrantConfig> = {}): SquadrantConfig {
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

describe("RuntimeRegistry", () => {
  it("returns cmux driver when no runtime set anywhere (default)", () => {
    const registry = new RuntimeRegistry({ cmux: stubDriver("cmux") });
    const driver = registry.forProject("nonexistent", baseConfig());
    expect(driver.name).toBe("cmux");
  });

  it("returns top-level runtime when set", () => {
    const registry = new RuntimeRegistry({
      cmux: stubDriver("cmux"),
      tmux: stubDriver("tmux"),
    });
    const driver = registry.forProject("any", baseConfig({ runtime: "tmux" }));
    expect(driver.name).toBe("tmux");
  });

  it("project-level runtime overrides top-level", () => {
    const registry = new RuntimeRegistry({
      cmux: stubDriver("cmux"),
      tmux: stubDriver("tmux"),
      docker: stubDriver("docker"),
    });
    const config = baseConfig({
      runtime: "tmux",
      projects: {
        brove: {
          path: "/p",
          captainName: "brove-captain",
          spokeVault: "~/s",
          host: "local",
          runtime: "docker",
        },
      },
    });
    const driver = registry.forProject("brove", config);
    expect(driver.name).toBe("docker");
  });

  it("throws when configured runtime has no driver registered", () => {
    const registry = new RuntimeRegistry({ cmux: stubDriver("cmux") });
    const config = baseConfig({ runtime: "unknown" });
    expect(() => registry.forProject("any", config)).toThrowError(/unknown/i);
  });

  it("global() returns the driver for the top-level runtime", () => {
    const registry = new RuntimeRegistry({
      cmux: stubDriver("cmux"),
      tmux: stubDriver("tmux"),
    });
    expect(registry.global(baseConfig({ runtime: "tmux" })).name).toBe("tmux");
    expect(registry.global(baseConfig()).name).toBe("cmux");
  });

  it("probeAll returns probe results keyed by driver name", async () => {
    const registry = new RuntimeRegistry({
      cmux: stubDriver("cmux"),
      tmux: stubDriver("tmux"),
    });
    const results = await registry.probeAll();
    expect(results.cmux.installed).toBe(true);
    expect(results.tmux.installed).toBe(true);
  });
});
