import { describe, it, expect } from "vitest";
import { resolveBackend, assertBackendUsable, shouldBuildRouterService } from "../router-resolution.js";
import type { RouterConfig } from "@squadrant/shared";

const router: RouterConfig = { kind: "opencode-go", baseUrl: "https://opencode.ai/zen/go" };

describe("resolveBackend", () => {
  it("prefers explicit > rule > role > native", () => {
    expect(resolveBackend("direct", "proxy", "native")).toBe("direct");
    expect(resolveBackend(undefined, "proxy", "native")).toBe("proxy");
    expect(resolveBackend(undefined, undefined, "proxy")).toBe("proxy");
    expect(resolveBackend(undefined, undefined, undefined)).toBe("native");
  });
});

describe("assertBackendUsable", () => {
  it("allows native for any agent", () => {
    expect(() => assertBackendUsable({ backend: "native", agent: "opencode", router: undefined })).not.toThrow();
  });
  it("allows direct/proxy for claude when router is configured", () => {
    expect(() => assertBackendUsable({ backend: "proxy", agent: "claude", router })).not.toThrow();
    expect(() => assertBackendUsable({ backend: "direct", agent: "claude", router })).not.toThrow();
  });
  it("rejects direct/proxy on a non-claude agent", () => {
    expect(() => assertBackendUsable({ backend: "proxy", agent: "opencode", router })).toThrow(/claude-only/);
  });
  it("rejects direct/proxy when defaults.router is absent", () => {
    expect(() => assertBackendUsable({ backend: "proxy", agent: "claude", router: undefined })).toThrow(
      /defaults\.router is not configured/,
    );
  });
});

describe("shouldBuildRouterService", () => {
  it("is true only when configured and not under vitest", () => {
    expect(shouldBuildRouterService(router, false)).toBe(true);
    expect(shouldBuildRouterService(router, true)).toBe(false);
    expect(shouldBuildRouterService(undefined, false)).toBe(false);
  });
});
