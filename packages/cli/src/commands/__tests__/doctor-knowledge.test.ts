import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig } from "@squadrant/shared";
import { knowledgeDoctorLines, workspaceDoctorLines } from "../doctor.js";

let hub: string;
beforeEach(() => { hub = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-kb-")); });
afterEach(() => fs.rmSync(hub, { recursive: true, force: true }));

describe("knowledgeDoctorLines", () => {
  it("emits nothing when no KB is configured (no new FAILs, cf. #876)", () => {
    expect(knowledgeDoctorLines(getDefaultConfig(), () => false)).toEqual([]);
  });
  it("flags a missing index and a missing markitdown (warn only)", () => {
    const c = getDefaultConfig();
    c.hubVault = hub;
    c.knowledgeBases = { saitex: { path: path.join(hub, "kb", "saitex") } };
    fs.mkdirSync(path.join(hub, "kb", "saitex"), { recursive: true });
    const lines = knowledgeDoctorLines(c, () => false);
    expect(lines).toEqual([
      expect.objectContaining({ label: "markitdown installed (rules KB conversion)", ok: false, warnOnly: true }),
      expect.objectContaining({ label: "KB 'saitex' index.json valid", ok: false }),
    ]);
  });
  it("warns about a KB still under <hubVault>/knowledge/", () => {
    const c = getDefaultConfig();
    c.hubVault = hub;
    fs.mkdirSync(path.join(hub, "knowledge", "saitex"), { recursive: true });
    expect(knowledgeDoctorLines(c, () => true)).toContainEqual(
      expect.objectContaining({ label: expect.stringContaining("saitex"), ok: false, warnOnly: true }));
  });
  it("warns about a leftover <spokeVault>/knowledge/rules overlay", () => {
    const c = getDefaultConfig();
    const spoke = path.join(hub, "spoke");
    fs.mkdirSync(path.join(spoke, "knowledge", "rules"), { recursive: true });
    c.projects = { flooros: { path: "/f", captainName: "f", spokeVault: spoke, host: "local" } };
    expect(knowledgeDoctorLines(c, () => true)).toContainEqual(
      expect.objectContaining({ label: expect.stringContaining("flooros"), ok: false, warnOnly: true }));
  });
});

describe("workspaceDoctorLines (#983)", () => {
  const saved = process.env.SQUADRANT_WORKSPACE_DIR;
  beforeEach(() => { process.env.SQUADRANT_WORKSPACE_DIR = path.join(hub, "ws"); });
  afterEach(() => { process.env.SQUADRANT_WORKSPACE_DIR = saved; });
  const project = (spoke: string) => ({ flooros: { path: "/f", captainName: "f", spokeVault: spoke, host: "local" } });

  it("warns about unmigrated spoke exchange and a missing workspace dir", () => {
    const c = getDefaultConfig();
    c.hubVault = hub;
    const spoke = path.join(hub, "spokes", "flooros");
    fs.mkdirSync(path.join(spoke, "handoffs"), { recursive: true });
    fs.writeFileSync(path.join(spoke, "handoffs", "2026-10-01.json"), "{}");
    c.projects = project(spoke);
    const lines = workspaceDoctorLines(c);
    expect(lines).toContainEqual(expect.objectContaining({ label: expect.stringContaining("not yet migrated"), ok: false, warnOnly: true, hint: expect.stringContaining("squadrant migrate kb") }));
    expect(lines).toContainEqual(expect.objectContaining({ label: "workspace dir for 'flooros' missing", ok: false, warnOnly: true }));
  });

  it("is quiet on a migrated home", () => {
    const c = getDefaultConfig();
    c.hubVault = hub;
    c.projects = project(path.join(hub, "spokes", "flooros"));
    fs.mkdirSync(path.join(hub, "ws", "flooros"), { recursive: true });
    const lines = workspaceDoctorLines(c);
    expect(lines.filter((l) => !l.ok)).toEqual([]);
    expect(lines).toContainEqual(expect.objectContaining({ label: "workspace dir for 'flooros' exists", ok: true }));
  });
});
