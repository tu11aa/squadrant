import { describe, it, expect } from "vitest";
import { captainIndicator } from "../status.js";

// #538: default `squadrant status` used to derive the ●/○ indicator from
// status.md's `captain_session` frontmatter, which nothing in the codebase
// writes — so it always rendered offline regardless of true liveness. The
// indicator must come from the daemon's registry-derived HealthState instead.
describe("captainIndicator (#538)", () => {
  it("alive → green filled circle", () => {
    expect(captainIndicator("alive")).toContain("●");
  });

  it("stale → still green filled circle (degrading but not dead)", () => {
    expect(captainIndicator("stale")).toContain("●");
  });

  it("gone → dim empty circle", () => {
    expect(captainIndicator("gone")).toContain("○");
  });

  it("stopped → dim empty circle", () => {
    expect(captainIndicator("stopped")).toContain("○");
  });

  it("unknown state → dim '?' (never asserts offline on missing data)", () => {
    expect(captainIndicator("unknown")).toContain("?");
  });

  it("no entry at all (daemon unreachable) → dim '?', not offline", () => {
    expect(captainIndicator(undefined)).toContain("?");
  });
});
