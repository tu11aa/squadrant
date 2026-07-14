import { describe, it, expect } from "vitest";
import { captainIndicator, formatProjectRow } from "../status.js";

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

// #549: a project without status.md used to be dropped from the table entirely
// ("no status.md", no health marker), hiding a captain that was demonstrably
// alive in the daemon's liveness registry. status.md is an opt-in human note,
// not the source of truth for whether the row renders — captain liveness must
// show regardless of whether status.md exists.
describe("formatProjectRow (#549)", () => {
  it("renders a live captain indicator even when status.md is missing", () => {
    const row = formatProjectRow("friendslop-factory", "friendslop-factory-captain", {}, false, "alive");
    expect(row).toContain("friendslop-factory");
    expect(row).toContain("●");
    expect(row).not.toContain("no status.md");
  });

  it("renders a dead captain indicator when status.md is missing and captain is gone", () => {
    const row = formatProjectRow("bet2fun-app", "bet2fun-app-captain", {}, false, "gone");
    expect(row).toContain("○");
  });

  it("still renders task/crew data from status.md when present", () => {
    const row = formatProjectRow(
      "squadrant",
      "squadrant-captain",
      { active_crew: 2, tasks_completed: 1, tasks_total: 4 },
      true,
      "alive",
    );
    expect(row).toContain("squadrant");
    expect(row).toContain("2");
  });
});
