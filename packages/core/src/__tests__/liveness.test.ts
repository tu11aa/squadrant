// packages/core/src/__tests__/liveness.test.ts
//
// Unit tests for the pure liveness helpers in @squadrant/core.
import { describe, it, expect } from "vitest";
import { ageText, healCmdFor } from "../liveness.js";
import type { ComponentHealth } from "../liveness.js";

// ── ageText ──────────────────────────────────────────────────────────────────

describe("ageText", () => {
  const now = 1_000_000;

  it("returns em-dash when lastSeenMs is null", () => {
    expect(ageText(null, now)).toBe("—");
  });

  it("returns seconds ago for a 5s old timestamp", () => {
    expect(ageText(now - 5_000, now)).toBe("5s ago");
  });

  it("returns minutes ago for a 2m old timestamp", () => {
    expect(ageText(now - 120_000, now)).toBe("2m ago");
  });

  it("returns hours ago for a 2h old timestamp", () => {
    expect(ageText(now - 7_200_000, now)).toBe("2h ago");
  });

  it("returns 0s ago when timestamps are equal", () => {
    expect(ageText(now, now)).toBe("0s ago");
  });
});

// ── healCmdFor ───────────────────────────────────────────────────────────────

function makeCaptain(state: ComponentHealth["state"], project = "brove"): ComponentHealth {
  return { kind: "captain", project, ref: `${project}-captain`, state, lastSeenMs: null };
}
function makeCrew(state: ComponentHealth["state"]): ComponentHealth {
  return { kind: "crew", project: "brove", ref: "worker-1", state, lastSeenMs: null };
}

describe("healCmdFor", () => {
  it("returns null for a gone captain (no heal verb exists)", () => {
    expect(healCmdFor(makeCaptain("gone"))).toBeNull();
  });

  it("returns null for an unknown captain", () => {
    expect(healCmdFor(makeCaptain("unknown"))).toBeNull();
  });

  it("returns null for an alive captain", () => {
    expect(healCmdFor(makeCaptain("alive"))).toBeNull();
  });

  it("returns null for a stale captain", () => {
    expect(healCmdFor(makeCaptain("stale"))).toBeNull();
  });

  it("returns null for crew (no heal verb exists)", () => {
    expect(healCmdFor(makeCrew("gone"))).toBeNull();
    expect(healCmdFor(makeCrew("unknown"))).toBeNull();
  });
});
