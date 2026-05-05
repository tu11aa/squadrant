import { describe, it, expect } from "vitest";
import type { ProjectStatus } from "../read-status.js";
import { renderDashboard, formatAge } from "../render.js";

function strip(s: string): string {
  // strip ANSI escape sequences for assertion clarity
  return s.replace(/\[[0-9;]*m/g, "");
}

const NOW = "2026-05-05T12:00:30.000Z";

describe("formatAge", () => {
  it("returns seconds when <60s", () => {
    expect(formatAge("2026-05-05T12:00:00.000Z", "2026-05-05T12:00:30.000Z")).toBe("30s");
  });
  it("returns minutes when <60m", () => {
    expect(formatAge("2026-05-05T11:58:00.000Z", "2026-05-05T12:00:30.000Z")).toBe("2m");
  });
  it("returns hours when <24h", () => {
    expect(formatAge("2026-05-05T09:00:00.000Z", "2026-05-05T12:00:30.000Z")).toBe("3h");
  });
  it("returns 'stale' when age >24h", () => {
    expect(formatAge("2026-05-03T12:00:00.000Z", "2026-05-05T12:00:30.000Z")).toBe("stale");
  });
  it("returns '?' when lastChecked is empty", () => {
    expect(formatAge("", NOW)).toBe("?");
  });
});

describe("renderDashboard", () => {
  const sample: ProjectStatus[] = [
    { project: "brove",         state: "idle",    lastChecked: "2026-05-05T12:00:00.000Z", captainWorkspace: "brove-captain",   excerpt: "Welcome to Claude Code\n│ > " },
    { project: "solder",        state: "busy",    lastChecked: "2026-05-05T11:58:00.000Z", captainWorkspace: "solder-captain",  excerpt: "✻ Cogitating… (3s)" },
    { project: "scaffoldstark", state: "blocked", lastChecked: "2026-05-05T11:59:45.000Z", captainWorkspace: "scaffold-captain", excerpt: "waiting for input from user" },
    { project: "feedback",      state: "errored", lastChecked: "2026-05-05T11:59:30.000Z", captainWorkspace: "feedback-captain", excerpt: "✗ build failed: cannot bind port" },
    { project: "retired",       state: "offline", lastChecked: "2026-05-04T12:00:00.000Z", captainWorkspace: "retired-captain",  excerpt: "[process exited with code 0]" },
    { project: "ghost",         state: "unknown", lastChecked: "",                          captainWorkspace: "ghost-captain",    excerpt: "" },
  ];

  it("renders one row per project", () => {
    const out = strip(renderDashboard(sample, { now: NOW, width: 100 }));
    for (const row of sample) expect(out).toContain(row.project);
  });

  it("includes the state label", () => {
    const out = strip(renderDashboard(sample, { now: NOW, width: 100 }));
    expect(out).toMatch(/idle/);
    expect(out).toMatch(/busy/);
    expect(out).toMatch(/blocked/);
    expect(out).toMatch(/errored/);
    expect(out).toMatch(/offline/);
    expect(out).toMatch(/unknown/);
  });

  it("renders ages relative to now", () => {
    const out = strip(renderDashboard(sample, { now: NOW, width: 100 }));
    expect(out).toContain("30s");      // brove
    expect(out).toContain("2m");       // solder
    expect(out).toContain("stale");    // retired
    expect(out).toContain("?");        // ghost
  });

  it("renders the first non-empty excerpt line per row", () => {
    const out = strip(renderDashboard(sample, { now: NOW, width: 200 }));
    expect(out).toContain("Welcome to Claude Code");
    expect(out).toContain("Cogitating");
    expect(out).toContain("waiting for input from user");
  });

  it("truncates excerpt to fit width", () => {
    const long = [{ ...sample[0], excerpt: "x".repeat(500) }];
    const out = strip(renderDashboard(long, { now: NOW, width: 80 }));
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("includes a footer with the current time and refresh hint", () => {
    const out = strip(renderDashboard(sample, { now: NOW, width: 100 }));
    expect(out).toContain("Refreshes every 10s");
  });

  it("handles the empty-projects case with a friendly message", () => {
    const out = strip(renderDashboard([], { now: NOW, width: 100 }));
    expect(out).toContain("No projects registered");
  });
});
