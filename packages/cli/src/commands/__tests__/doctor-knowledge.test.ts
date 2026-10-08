import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig } from "@squadrant/shared";
import { kbDir } from "@squadrant/core";
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
    c.knowledge = { saitex: {} };
    fs.mkdirSync(kbDir(hub, "saitex"), { recursive: true });
    const lines = knowledgeDoctorLines(c, () => false);
    expect(lines).toEqual([
      expect.objectContaining({ label: "markitdown installed (rules KB conversion)", ok: false, warnOnly: true }),
      expect.objectContaining({ label: "KB 'saitex' index.json valid", ok: false }),
    ]);
  });
});
