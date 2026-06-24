import { describe, it, expect } from "vitest";
import { checkToolCompat } from "../tool-compat.js";

describe("checkToolCompat", () => {
  it("returns null when version is within range", () => {
    expect(checkToolCompat("cmux", "cmux 0.64.8", { min: "0.64.0", lastVerified: "0.64.17" })).toBeNull();
  });

  it("returns null when version equals min exactly", () => {
    expect(checkToolCompat("cmux", "cmux 0.64.0", { min: "0.64.0", lastVerified: "0.64.17" })).toBeNull();
  });

  it("returns null when version equals lastVerified exactly", () => {
    expect(checkToolCompat("cmux", "cmux 0.64.17", { min: "0.64.0", lastVerified: "0.64.17" })).toBeNull();
  });

  it("warns when version is below min", () => {
    const warn = checkToolCompat("cmux", "cmux 0.63.5", { min: "0.64.0", lastVerified: "0.64.17" });
    expect(warn).not.toBeNull();
    expect(warn).toMatch(/< min/);
    expect(warn).toMatch(/0\.64\.0/);
    expect(warn).toMatch(/upgrade/i);
  });

  it("warn message includes tool name and installed version when below min", () => {
    const warn = checkToolCompat("cmux", "cmux 0.63.5", { min: "0.64.0" });
    expect(warn).toMatch(/^cmux cmux 0\.63\.5 </);
  });

  it("warns when installed version exceeds lastVerified (drift signal)", () => {
    const warn = checkToolCompat("cmux", "cmux 0.65.0", { min: "0.64.0", lastVerified: "0.64.17" });
    expect(warn).not.toBeNull();
    expect(warn).toMatch(/last-verified/);
    expect(warn).toMatch(/0\.64\.17/);
    expect(warn).toMatch(/compat audit/i);
  });

  it("warn message includes tool name and installed version when above lastVerified", () => {
    const warn = checkToolCompat("cmux", "cmux 0.65.0", { min: "0.64.0", lastVerified: "0.64.17" });
    expect(warn).toMatch(/cmux 0\.65\.0 > last-verified 0\.64\.17/);
  });

  it("returns null when no lastVerified and version is above min", () => {
    expect(checkToolCompat("claude", "claude 2.2.0", { min: "2.1.32" })).toBeNull();
  });

  it("returns null when version string has no parseable semver", () => {
    expect(checkToolCompat("cmux", "unknown build", { min: "0.64.0" })).toBeNull();
  });

  it("returns null for empty version string", () => {
    expect(checkToolCompat("cmux", "", { min: "0.64.0" })).toBeNull();
  });

  it("works with just a bare semver string (no tool name prefix)", () => {
    expect(checkToolCompat("claude", "2.1.32", { min: "2.1.32" })).toBeNull();
    const warn = checkToolCompat("claude", "2.1.31", { min: "2.1.32" });
    expect(warn).toMatch(/< min/);
  });

  it("compares patch level correctly (minor ok, patch below min)", () => {
    const warn = checkToolCompat("cmux", "cmux 0.64.15", { min: "0.64.16", lastVerified: "0.64.20" });
    expect(warn).toMatch(/< min/);
  });

  it("compares major version correctly (major above min → in range without lastVerified)", () => {
    expect(checkToolCompat("claude", "claude 3.0.0", { min: "2.1.32" })).toBeNull();
  });

  // Optional-min entries (codex/gemini/opencode — presence-checked, no floor enforced yet)
  it("returns null when min is absent and version is below lastVerified", () => {
    expect(checkToolCompat("codex", "codex-cli 0.100.0", { lastVerified: "0.139.0" })).toBeNull();
  });

  it("warns when min is absent but version is above lastVerified (drift)", () => {
    const warn = checkToolCompat("codex", "codex-cli 0.200.0", { lastVerified: "0.139.0" });
    expect(warn).not.toBeNull();
    expect(warn).toMatch(/last-verified/);
  });

  it("returns null when only lastVerified is set and version matches it exactly", () => {
    expect(checkToolCompat("opencode", "1.17.4", { lastVerified: "1.17.4" })).toBeNull();
  });

  // Manifest shape: all six tools should produce a null when version is in-range
  it("manifest tool entries for cmux/claude/node each have a min and are checkable", () => {
    expect(checkToolCompat("cmux",  "cmux 0.64.17", { min: "0.64.0",  lastVerified: "0.64.17" })).toBeNull();
    expect(checkToolCompat("claude","claude 2.1.32", { min: "2.1.32" })).toBeNull();
    expect(checkToolCompat("node",  "22.0.0",        { min: "18.0.0", lastVerified: "24.6.0" })).toBeNull();
  });
});
