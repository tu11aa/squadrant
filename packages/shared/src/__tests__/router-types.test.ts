import { describe, it, expect } from "vitest";
import {
  getDefaultConfig,
  ROUTER_KINDS,
  isRouterKind,
  isBackendMode,
  type BackendMode,
  type RouterConfig,
} from "../config.js";

describe("router config types", () => {
  it("enumerates exactly the recognized router kinds", () => {
    expect(ROUTER_KINDS).toEqual(["opencode-go", "openrouter", "ccr", "litellm", "custom"]);
  });

  it("accepts every valid router kind and rejects an unknown one", () => {
    for (const kind of ROUTER_KINDS) {
      expect(isRouterKind(kind)).toBe(true);
    }
    expect(isRouterKind("bogus")).toBe(false);
  });

  it("accepts every backend mode and rejects unknown / empty values", () => {
    for (const mode of ["native", "direct", "proxy"]) {
      expect(isBackendMode(mode)).toBe(true);
    }
    expect(isBackendMode("router")).toBe(false);
    expect(isBackendMode("")).toBe(false);
  });

  it("accepts defaults.router and per-role/per-rule backend", () => {
    const router: RouterConfig = {
      kind: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go",
      apiKeyEnv: "OPENCODE_GO_KEY",
      authHeader: "x-api-key",
      extraHeaders: { "x-opencode-session": "squadrant" },
      port: 0,
      isAnthropic: false,
      models: { flash: { upstream: "deepseek-v4.1-flash", agents: { opencode: "opencode-go/deepseek-v4.1-flash" } } },
    };
    const mode: BackendMode = "proxy";
    const c = getDefaultConfig();
    c.defaults.router = router;
    c.defaults.roles = { ...c.defaults.roles, crew: { agent: "claude", backend: mode, model: "flash" } };
    c.defaults.crewRouting = { rules: [{ tier: "hard", match: "refactor", agent: "claude", backend: "proxy", model: "flash" }] };

    expect(c.defaults.router?.kind).toBe("opencode-go");
    expect(c.defaults.roles?.crew?.backend).toBe("proxy");
    expect(c.defaults.crewRouting?.rules[0].backend).toBe("proxy");
  });
});
