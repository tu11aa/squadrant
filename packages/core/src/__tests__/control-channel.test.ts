// Tests for the ControlChannel port's pure helpers (#667 slice 2).
import { describe, it, expect } from "vitest";
import { fallsBackToPane, describeOutcome } from "../control-channel.js";
import type { DeliveryOutcome } from "../control-channel.js";

describe("fallsBackToPane", () => {
  it("gone falls back — the session is dead, the pane is the last resort", () => {
    expect(fallsBackToPane({ status: "gone" })).toBe(true);
  });

  it("unsupported falls back — no channel for this agent", () => {
    expect(fallsBackToPane({ status: "unsupported" })).toBe(true);
  });

  it("accepted does NOT fall back", () => {
    expect(fallsBackToPane({ status: "accepted", via: "opencode-http" })).toBe(false);
  });

  it("queued does NOT fall back — accepted while mid-turn is still accepted", () => {
    // This is the #657 shape: the message arrived and is queued. Treating it as a
    // failure and re-sending is exactly the duplicate-message bug.
    expect(fallsBackToPane({ status: "queued", via: "opencode-http" })).toBe(false);
  });

  it("held does NOT fall back — it is surfaced to the operator, never retried", () => {
    expect(fallsBackToPane({ status: "held", via: "claude-peer", reason: "approval" })).toBe(false);
  });
});

describe("describeOutcome — every outcome must be loggable", () => {
  const cases: DeliveryOutcome[] = [
    { status: "accepted", via: "opencode-http" },
    { status: "queued", via: "opencode-http" },
    { status: "held", via: "claude-peer", reason: "awaiting approval" },
    { status: "gone" },
    { status: "unsupported" },
  ];

  it("produces a non-empty description for all five branches", () => {
    for (const c of cases) expect(describeOutcome(c).length).toBeGreaterThan(0);
  });

  it("includes the channel name when there is one", () => {
    expect(describeOutcome({ status: "accepted", via: "opencode-http" })).toContain("opencode-http");
  });

  it("includes the reason for held — the operator needs to know why", () => {
    expect(describeOutcome({ status: "held", via: "claude-peer", reason: "awaiting approval" }))
      .toContain("awaiting approval");
  });
});
describe("accepted confirmation flag (#667 slice 3)", () => {
  it("renders an unconfirmed accept distinctly from a confirmed one", () => {
    expect(describeOutcome({ status: "accepted", via: "claude-peer", confirmed: true }))
      .toBe("accepted via claude-peer");
    expect(describeOutcome({ status: "accepted", via: "claude-peer", confirmed: false }))
      .toBe("accepted via claude-peer (unconfirmed — no turn observed)");
  });

  it("omitted confirmed reads as a plain accept (slice 2 callers unchanged)", () => {
    expect(describeOutcome({ status: "accepted", via: "opencode-http" }))
      .toBe("accepted via opencode-http");
  });

  it("an unconfirmed accept still does NOT fall back to the pane", () => {
    // Critical: unconfirmed means "we don't know the agent read it", NOT "it failed".
    // Falling back here would double-send — the exact duplicate this port removes.
    expect(fallsBackToPane({ status: "accepted", via: "claude-peer", confirmed: false })).toBe(false);
  });
});
