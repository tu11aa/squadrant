import { describe, it, expect } from "vitest";
import { resolveRouterModel } from "../router-model.js";
import type { RouterConfig } from "../config.js";

const router: RouterConfig = {
  kind: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go",
  models: { flash: { upstream: "deepseek-v4.1-flash", agents: { opencode: "opencode-go/deepseek-v4.1-flash" } } },
};

describe("resolveRouterModel", () => {
  it("expands an alias to the upstream id for claude", () => {
    expect(resolveRouterModel("flash", "claude", router)).toBe("deepseek-v4.1-flash");
  });
  it("expands an alias to the per-agent id for opencode", () => {
    expect(resolveRouterModel("flash", "opencode", router)).toBe("opencode-go/deepseek-v4.1-flash");
  });
  it("passes an unknown value through as a literal", () => {
    expect(resolveRouterModel("deepseek/deepseek-chat", "claude", router)).toBe("deepseek/deepseek-chat");
    expect(resolveRouterModel("opencode-go/deepseek-v4.1-flash", "opencode", router)).toBe("opencode-go/deepseek-v4.1-flash");
  });
  it("returns undefined when there is no model", () => {
    expect(resolveRouterModel(undefined, "claude", router)).toBeUndefined();
  });
  it("returns the model unchanged when router is absent", () => {
    expect(resolveRouterModel("flash", "claude", undefined)).toBe("flash");
  });
});
