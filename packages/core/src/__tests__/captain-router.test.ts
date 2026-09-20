// Unit tests for prepareCaptainRoute (#772 follow-up): a router-backed captain
// launch must use permission_mode=default + SQUADRANT_GATE=on and carry the
// router env in a per-spawn --settings file. Native stays byte-for-byte
// unchanged. No I/O — deps are injected.

import { describe, it, expect, vi } from "vitest";
import { getDefaultConfig } from "@squadrant/shared";
import type { SquadrantConfig } from "@squadrant/shared";
import { prepareCaptainRoute } from "../captain-router.js";

function makeConfig(overrides: Partial<SquadrantConfig["defaults"]> = {}): SquadrantConfig {
  const base = getDefaultConfig();
  return { ...base, defaults: { ...base.defaults, ...overrides } };
}

const ROUTER = {
  kind: "opencode-go" as const,
  baseUrl: "https://opencode.ai/zen/go",
  apiKey: "k",
};

function deps(over: Partial<Parameters<typeof prepareCaptainRoute>[0]["deps"]> = {}) {
  return {
    routerCredentials: vi.fn().mockResolvedValue({
      backend: "proxy" as const,
      baseUrl: "http://127.0.0.1:53421",
      token: "minted-tok",
    }),
    writeRouterSettings: vi.fn().mockReturnValue("/state/proj/captain/router-settings.json"),
    ...over,
  };
}

function baseInput(over: Partial<Parameters<typeof prepareCaptainRoute>[0]> = {}) {
  return {
    backend: "native" as const,
    agentName: "claude",
    configuredPermissionMode: "auto",
    project: "proj",
    model: "deepseek-v4.1-flash",
    stateRoot: "/state",
    config: makeConfig({ router: ROUTER }),
    deps: deps(),
    ...over,
  };
}

describe("prepareCaptainRoute (#772)", () => {
  it("native: keeps the configured permission mode and injects nothing", async () => {
    const input = baseInput();
    const res = await prepareCaptainRoute(input);
    expect(res.permissionMode).toBe("auto");
    expect(res.settingsPath).toBeUndefined();
    expect(res.env).toEqual({});
    expect(res.model).toBe("deepseek-v4.1-flash");
    expect(input.deps.routerCredentials).not.toHaveBeenCalled();
    expect(input.deps.writeRouterSettings).not.toHaveBeenCalled();
  });

  it("routed: selects default, injects SQUADRANT_GATE=on, and writes the --settings file", async () => {
    const input = baseInput({ backend: "proxy" });
    const res = await prepareCaptainRoute(input);

    expect(res.permissionMode).toBe("default");
    expect(res.env.SQUADRANT_GATE).toBe("on");
    expect(res.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:53421");
    expect(res.settingsPath).toBe("/state/proj/captain/router-settings.json");
    expect(input.deps.routerCredentials).toHaveBeenCalledWith({ project: "proj", backend: "proxy" });
    expect(input.deps.writeRouterSettings).toHaveBeenCalledWith({
      stateRoot: "/state",
      project: "proj",
      taskId: "captain",
      env: expect.objectContaining({
        ANTHROPIC_BASE_URL: "http://127.0.0.1:53421",
        ANTHROPIC_AUTH_TOKEN: "minted-tok",
        ANTHROPIC_MODEL: "deepseek-v4.1-flash",
      }),
    });
  });

  it("routed: carries the operator's non-ANTHROPIC claudeEnv keys into the --settings env (D1)", async () => {
    const input = baseInput({
      backend: "proxy",
      config: makeConfig({
        router: ROUTER,
        claudeEnv: {
          ANTHROPIC_BASE_URL: "https://opencode.ai/zen/go",
          CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
          CLAUDE_AFK_TIMEOUT_MS: "240000",
        },
      }),
    });
    await prepareCaptainRoute(input);

    const env = vi.mocked(input.deps.writeRouterSettings!).mock.calls[0]![0].env;
    expect(env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT).toBe("1");
    expect(env.CLAUDE_AFK_TIMEOUT_MS).toBe("240000");
    // The shim wins — claudeEnv's ANTHROPIC_BASE_URL must NOT leak through.
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:53421");
    expect(env.ANTHROPIC_BASE_URL).not.toBe("https://opencode.ai/zen/go");
  });

  it("routed: expands a router.models alias for the captain model", async () => {
    const input = baseInput({
      backend: "proxy",
      model: "flash",
      config: makeConfig({ router: { ...ROUTER, models: { flash: { upstream: "upstream-id" } } } }),
    });
    const res = await prepareCaptainRoute(input);
    expect(res.model).toBe("upstream-id");
    expect(input.deps.writeRouterSettings).toHaveBeenCalledWith(
      expect.objectContaining({ env: expect.objectContaining({ ANTHROPIC_MODEL: "upstream-id" }) }),
    );
  });

  it("fails loud when a routed captain has no --settings writer", async () => {
    const input = baseInput({ backend: "proxy", deps: deps({ writeRouterSettings: undefined }) });
    await expect(prepareCaptainRoute(input)).rejects.toThrow(/per-spawn --settings writer/);
  });

  it("fails loud when a routed captain has no credentials provider", async () => {
    const input = baseInput({ backend: "proxy", deps: deps({ routerCredentials: undefined }) });
    await expect(prepareCaptainRoute(input)).rejects.toThrow(/credentials/);
  });

  it("rejects a routed non-claude agent (direct/proxy are claude-only)", async () => {
    const input = baseInput({ backend: "proxy", agentName: "opencode" });
    await expect(prepareCaptainRoute(input)).rejects.toThrow(/claude-only/);
  });

  it("warns when defaults.claudeEnv sets ANTHROPIC_* on a routed launch", async () => {
    const warn = vi.fn();
    const input = baseInput({
      backend: "proxy",
      warn,
      config: makeConfig({
        router: ROUTER,
        claudeEnv: { ANTHROPIC_BASE_URL: "https://opencode.ai/zen/go", CLAUDE_AFK_TIMEOUT_MS: "1" },
      }),
    });
    await prepareCaptainRoute(input);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("ANTHROPIC_BASE_URL");
    expect(warn.mock.calls[0]![0]).toMatch(/shadow the router shim/i);
  });

  it("does not warn when claudeEnv has no ANTHROPIC_* keys", async () => {
    const warn = vi.fn();
    const input = baseInput({
      backend: "proxy",
      warn,
      config: makeConfig({ router: ROUTER, claudeEnv: { CLAUDE_AFK_TIMEOUT_MS: "1" } }),
    });
    await prepareCaptainRoute(input);
    expect(warn).not.toHaveBeenCalled();
  });
});
