import { describe, it, expect, vi } from "vitest";
import { NotifierRegistry } from "../registry.js";
import type { NotifierDriver, NotifierScope } from "../types.js";
import type { CockpitConfig } from "@cockpit/shared";

function stubFactory(name: string): (scope: NotifierScope) => NotifierDriver {
  return (_scope) => ({
    name,
    probe: vi.fn(async () => ({ installed: true, reachable: true })),
    notify: vi.fn(async () => {}),
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

describe("NotifierRegistry", () => {
  it("returns cmux driver by default", () => {
    const registry = new NotifierRegistry({ cmux: stubFactory("cmux") });
    expect(registry.get(baseConfig()).name).toBe("cmux");
  });

  it("uses config.notifier override", () => {
    const registry = new NotifierRegistry({
      cmux: stubFactory("cmux"),
      slack: stubFactory("slack"),
    });
    expect(registry.get(baseConfig({ notifier: "slack" })).name).toBe("slack");
  });

  it("throws when configured provider has no factory", () => {
    const registry = new NotifierRegistry({ cmux: stubFactory("cmux") });
    expect(() => registry.get(baseConfig({ notifier: "unknown" }))).toThrowError(/unknown/i);
  });

  it("probeAll returns results keyed by provider name", async () => {
    const registry = new NotifierRegistry({
      cmux: stubFactory("cmux"),
      slack: stubFactory("slack"),
    });
    const results = await registry.probeAll();
    expect(results.cmux.installed).toBe(true);
    expect(results.slack.installed).toBe(true);
  });
});
