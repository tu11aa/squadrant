import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig } from "@squadrant/shared";
import { knowledgeDoctorLines } from "../doctor.js";

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
