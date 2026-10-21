import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundMessage } from "../lib/bound-message.js";
import { resolveCaptainCrewTier } from "../project-config.js";
import { loadProjectOverride, saveProjectOverride, projectConfigPath, resolveNotify, DEFAULT_NOTIFY, crewRank, isQuieter } from "../project-config.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sq-pc-"));
});

describe("project override file", () => {
  it("returns {} when the file is absent", () => {
    expect(loadProjectOverride("squadrant", root)).toEqual({});
  });

  it("round-trips a saved override", () => {
    saveProjectOverride("squadrant", { telegram: { notify: { crew: "all" } } }, root);
    expect(loadProjectOverride("squadrant", root)).toEqual({ telegram: { notify: { crew: "all" } } });
    expect(projectConfigPath("squadrant", root)).toBe(path.join(root, "projects", "squadrant.json"));
  });

  it("deep-merges on save, preserving sibling keys", () => {
    saveProjectOverride("squadrant", { telegram: { notify: { cap: false } } }, root);
    saveProjectOverride("squadrant", { telegram: { notify: { crew: "none" } } }, root);
    expect(loadProjectOverride("squadrant", root)).toEqual({ telegram: { notify: { cap: false, crew: "none" } } });
  });
});

describe("resolveNotify", () => {
  it("returns built-in defaults with no global and no override", () => {
    expect(resolveNotify(undefined, {})).toEqual({ active: false, cap: true, crew: "alert_only" });
    expect(DEFAULT_NOTIFY).toEqual({ active: false, cap: true, crew: "alert_only" });
  });

  it("global overrides built-in", () => {
    expect(resolveNotify({ crew: "done_only" }, {})).toEqual({ active: false, cap: true, crew: "done_only" });
  });

  it("project overrides global per-key, keeping siblings", () => {
    const r = resolveNotify({ cap: false, crew: "done_only" }, { telegram: { notify: { crew: "all" } } });
    expect(r).toEqual({ active: false, cap: false, crew: "all" });
  });
});

describe("notify transition helpers", () => {
  const base = { active: true, cap: true, crew: "all" } as const;
  it("crewRank orders tiers", () => {
    expect(crewRank("none")).toBe(0);
    expect(crewRank("done_only")).toBe(1);
    expect(crewRank("alert_only")).toBe(2);
    expect(crewRank("all")).toBe(3);
  });
  it("cap on→off is quieter", () => {
    expect(isQuieter({ ...base }, { ...base, cap: false })).toEqual({ quieter: true, dim: "cap" });
  });
  it("active on→off is quieter", () => {
    expect(isQuieter({ ...base }, { ...base, active: false })).toEqual({ quieter: true, dim: "active" });
  });
  it("crew all→none is quieter", () => {
    expect(isQuieter({ ...base }, { ...base, crew: "none" })).toEqual({ quieter: true, dim: "crew" });
  });
  it("louder / unchanged is not quieter", () => {
    expect(isQuieter({ ...base, cap: false }, { ...base }).quieter).toBe(false);
    expect(isQuieter({ ...base }, { ...base }).quieter).toBe(false);
    expect(isQuieter({ ...base, crew: "none" }, { ...base, crew: "all" }).quieter).toBe(false);
  });
});

describe("captain-pane crew tier (#1017)", () => {
  it("defaults to alert_only and honours a per-project override", () => {
    expect(resolveCaptainCrewTier({})).toBe("alert_only");
    expect(resolveCaptainCrewTier({ captain: { notify: { crew: "all" } } })).toBe("all");
  });
  it("is independent of the Telegram tier", () => {
    expect(resolveCaptainCrewTier({ telegram: { notify: { crew: "all" } } })).toBe("alert_only");
  });
});

describe("boundMessage (#1017)", () => {
  it("leaves short text alone and truncates long text with a marker", () => {
    expect(boundMessage("  hi  ")).toBe("hi");
    const out = boundMessage("a".repeat(2000), 1500);
    expect(out.startsWith("a".repeat(1500))).toBe(true);
    expect(out).toMatch(/\[truncated, 500 more chars\]$/);
  });
});
