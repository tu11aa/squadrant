import { describe, it, expect } from "vitest";
import { resolveEffort, getDefaultConfig } from "@cockpit/shared";

describe("resolveEffort", () => {
  it("returns 'balance' when effort is absent", () => {
    const config = getDefaultConfig();
    delete (config.defaults as any).effort;
    expect(resolveEffort(config)).toBe("balance");
  });

  it("returns 'max' when explicitly set to max", () => {
    const config = getDefaultConfig();
    (config.defaults as any).effort = "max";
    expect(resolveEffort(config)).toBe("max");
  });

  it("returns 'balance' when explicitly set to balance", () => {
    const config = getDefaultConfig();
    (config.defaults as any).effort = "balance";
    expect(resolveEffort(config)).toBe("balance");
  });

  it("returns 'low' when explicitly set to low", () => {
    const config = getDefaultConfig();
    (config.defaults as any).effort = "low";
    expect(resolveEffort(config)).toBe("low");
  });
});
