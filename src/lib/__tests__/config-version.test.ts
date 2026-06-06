import { describe, it, expect } from "vitest";
import { readStamp, needsCheck, withStamp } from "../config-version.js";
import type { CockpitConfig } from "../../config.js";

const base = (over: Partial<CockpitConfig> = {}): CockpitConfig =>
  ({ commandName: "x", hubVault: "/h", projects: {}, defaults: {} as any, metrics: { enabled: false, path: "/m" }, ...over });

describe("config-version", () => {
  it("readStamp returns the stamp or null", () => {
    expect(readStamp(base({ _cockpitVersion: "0.5.2" }))).toBe("0.5.2");
    expect(readStamp(base())).toBeNull();
  });

  it("needsCheck is true when stamp is missing (legacy config)", () => {
    expect(needsCheck(base(), "0.5.3")).toBe(true);
  });

  it("needsCheck is true when stamp differs from pkg version", () => {
    expect(needsCheck(base({ _cockpitVersion: "0.5.2" }), "0.5.3")).toBe(true);
  });

  it("needsCheck is false when stamp equals pkg version", () => {
    expect(needsCheck(base({ _cockpitVersion: "0.5.3" }), "0.5.3")).toBe(false);
  });

  it("withStamp returns a new config object with the stamp set (no mutation)", () => {
    const input = base();
    const out = withStamp(input, "0.5.3");
    expect(out._cockpitVersion).toBe("0.5.3");
    expect(input._cockpitVersion).toBeUndefined(); // original untouched
  });
});
