// src/commands/__tests__/health-view.test.ts
import { describe, it, expect } from "vitest";
import { healthIcon, ageText, healthRow } from "../health-view.js";
import type { ComponentHealth } from "@cockpit/core";

describe("health-view (pure rendering)", () => {
  it("healthIcon maps every state", () => {
    expect(healthIcon("alive")).toBeTruthy();
    expect(healthIcon("gone")).toBeTruthy();
    expect(healthIcon("alive")).not.toBe(healthIcon("gone"));
  });

  it("ageText: null → em-dash; seconds/minutes/hours buckets", () => {
    expect(ageText(null, 100_000)).toBe("—");
    expect(ageText(95_000, 100_000)).toBe("5s ago");
    expect(ageText(40_000, 100_000)).toBe("1m ago");
    expect(ageText(100_000 - 2 * 3_600_000, 100_000)).toBe("2h ago");
  });

  it("healthRow includes ref + state for an alive crew", () => {
    const c: ComponentHealth = {
      kind: "crew", project: "p", ref: "alpha", state: "alive", lastSeenMs: 900, detail: "working",
    };
    const row = healthRow(c, 900);
    expect(row).toContain("alpha");
    expect(row).toContain("alive");
  });
});
