// src/control/__tests__/interactive-registry.test.ts
import { describe, it, expect } from "vitest";
import { getInteractiveAdapter } from "../interactive/registry.js";

describe("interactive registry", () => {
  it("claude is strong tier", () => {
    expect(getInteractiveAdapter("claude").tier).toBe("strong");
  });
  it("codex no longer registered as hook adapter (uses CodexInteractiveDriver instead)", () => {
    expect(() => getInteractiveAdapter("codex")).toThrow(/no interactive adapter/i);
  });
  it("unknown provider throws", () => {
    expect(() => getInteractiveAdapter("gemini")).toThrow(/no interactive adapter/i);
  });
});
