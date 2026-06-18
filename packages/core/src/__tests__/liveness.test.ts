// packages/core/src/__tests__/liveness.test.ts
//
// Unit tests for the pure liveness helpers relocated from src/commands/
// into @cockpit/core. These tests run in the core package so the functions
// have a stable, import-path-verified home before the dashboard move.
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

function makeRelay(state: ComponentHealth["state"], project = "brove"): ComponentHealth {
  return { kind: "relay", project, ref: "relay", state, lastSeenMs: null };
}
function makeCaptain(state: ComponentHealth["state"]): ComponentHealth {
  return { kind: "captain", project: "brove", ref: "brove-captain", state, lastSeenMs: null };
}
function makeCrew(state: ComponentHealth["state"]): ComponentHealth {
  return { kind: "crew", project: "brove", ref: "worker-1", state, lastSeenMs: null };
}

describe("healCmdFor", () => {
  it("returns heal relay cmd for a gone relay", () => {
    expect(healCmdFor(makeRelay("gone", "brove"))).toBe("cockpit heal relay --project brove");
  });

  it("returns heal relay cmd for an unknown relay", () => {
    expect(healCmdFor(makeRelay("unknown", "scaffold"))).toBe("cockpit heal relay --project scaffold");
  });

  it("returns null for an alive relay", () => {
    expect(healCmdFor(makeRelay("alive"))).toBeNull();
  });

  it("returns null for a stale relay", () => {
    expect(healCmdFor(makeRelay("stale"))).toBeNull();
  });

  it("returns null for non-relay components (no heal verb exists)", () => {
    expect(healCmdFor(makeCaptain("gone"))).toBeNull();
    expect(healCmdFor(makeCrew("gone"))).toBeNull();
  });
});
