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
// alive in the daemon's liveness registry. Captain liveness must show
// regardless of status.md.
// #630: status.md/write-status.sh are dead (the script doesn't exist, nothing
// writes the file) — formatProjectRow no longer reads it at all, so there's
// no "ok"/"missing"/"unreadable" distinction left to render.
describe("formatProjectRow (#549, #630)", () => {
  it("renders a live captain indicator", () => {
    const row = formatProjectRow("friendslop-factory", "friendslop-factory-captain", "alive");
    expect(row).toContain("friendslop-factory");
    expect(row).toContain("●");
  });

  it("renders a dead captain indicator when captain is gone", () => {
    const row = formatProjectRow("bet2fun-app", "bet2fun-app-captain", "gone");
    expect(row).toContain("○");
  });

  it("renders the unknown-liveness glyph when the daemon has no entry", () => {
    const row = formatProjectRow("p", "p-captain", undefined);
    expect(row).toContain("?");
  });
});
