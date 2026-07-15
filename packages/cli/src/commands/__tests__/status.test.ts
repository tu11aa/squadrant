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

  it("gone → dim empty circle (a fault — the captain crashed)", () => {
    expect(captainIndicator("gone")).toContain("○");
  });

  it("unknown state → dim '?' (never asserts offline on missing data)", () => {
    expect(captainIndicator("unknown")).toContain("?");
  });

  it("no entry at all (daemon unreachable) → dim '?', not offline", () => {
    expect(captainIndicator(undefined)).toContain("?");
  });
});

// #549 follow-up: 'stopped' (clean, deliberate shutdown) and 'gone' (crashed /
// dark past the gone window) used to render identically (both dim ○), so an
// operator who deliberately closed a captain could not tell that apart from
// one that died on them. liveness.ts already separates the two states (#324:
// "clean close — magenta, not a fault") — the CLI must reflect that distinction
// instead of collapsing both into the same fault-looking glyph.
describe("captainIndicator — stopped vs gone (#549)", () => {
  it("stopped renders a distinct glyph from gone", () => {
    expect(captainIndicator("stopped")).not.toBe(captainIndicator("gone"));
  });

  it("stopped is NOT the fault-looking empty circle", () => {
    expect(captainIndicator("stopped")).not.toContain("○");
  });
});

// #549: a project without status.md used to be dropped from the table entirely
// ("no status.md", no health marker), hiding a captain that was demonstrably
// alive in the daemon's liveness registry. status.md is an opt-in human note,
// not the source of truth for whether the row renders — captain liveness must
// show regardless of whether status.md exists.
describe("formatProjectRow (#549)", () => {
  it("renders a live captain indicator even when status.md is missing", () => {
    const row = formatProjectRow("friendslop-factory", "friendslop-factory-captain", {}, "missing", "alive");
    expect(row).toContain("friendslop-factory");
    expect(row).toContain("●");
    expect(row).not.toContain("no status.md");
  });

  it("renders a dead captain indicator when status.md is missing and captain is gone", () => {
    const row = formatProjectRow("bet2fun-app", "bet2fun-app-captain", {}, "missing", "gone");
    expect(row).toContain("○");
  });

  it("still renders task/crew data from status.md when present", () => {
    const row = formatProjectRow(
      "squadrant",
      "squadrant-captain",
      { active_crew: 2, tasks_completed: 1, tasks_total: 4 },
      "ok",
      "alive",
    );
    expect(row).toContain("squadrant");
    expect(row).toContain("2");
  });
});

// #549 follow-up: an unreadable/corrupt status.md used to be swallowed by an
// empty catch block that fell through to the same "missing" rendering as a
// project that never had a status.md at all — the operator silently lost the
// fact that their file was broken. A corrupt file must stay visibly distinct
// from an absent one.
describe("formatProjectRow — unreadable status.md must stay visible (#549)", () => {
  it("renders distinctly from a missing status.md", () => {
    const missingRow = formatProjectRow("p", "p-captain", {}, "missing", "alive");
    const unreadableRow = formatProjectRow("p", "p-captain", {}, "unreadable", "alive");
    expect(unreadableRow).not.toBe(missingRow);
  });

  it("flags the row as unreadable, not silently as 'no notes'", () => {
    const row = formatProjectRow("p", "p-captain", {}, "unreadable", "alive");
    expect(row).toContain("unreadable");
    expect(row).not.toContain("no notes");
  });

  it("still shows live captain state on an unreadable status.md, not dropped", () => {
    const row = formatProjectRow("p", "p-captain", {}, "unreadable", "alive");
    expect(row).toContain("●");
  });
});
