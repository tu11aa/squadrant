import { describe, it, expect } from "vitest";
import { getDefaultConfig, type BackendMode, type RouterConfig } from "../config.js";

describe("router config types", () => {
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
