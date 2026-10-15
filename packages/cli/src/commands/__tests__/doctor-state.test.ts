import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stateDoctorLines } from "../doctor.js";

let tmp: string; let root: string; let legacy: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-state-"));
  root = path.join(tmp, "new"); legacy = path.join(tmp, "legacy");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const base = () => ({ root, legacy, loadedLogPath: null, desiredLogPath: "/x/logs/squadrantd.log" });

describe("stateDoctorLines (#983 6a)", () => {
  it("is silent when there is no legacy state dir, or it is empty", () => {
    expect(stateDoctorLines(base())).toEqual([]);
    fs.mkdirSync(legacy, { recursive: true });
    expect(stateDoctorLines(base())).toEqual([]);
    fs.mkdirSync(path.join(legacy, "proj", "tasks"), { recursive: true }); // left empty by `migrate kb`
    expect(stateDoctorLines(base())).toEqual([]);
  });

  it("flags a legacy state dir that still holds data (warn only)", () => {
    fs.mkdirSync(path.join(legacy, "proj"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "liveness.json"), "{}");
    const lines = stateDoctorLines(base());
    expect(lines).toEqual([expect.objectContaining({ ok: false, warnOnly: true, label: expect.stringContaining(legacy) })]);
    expect(lines[0].hint).toMatch(/not copied yet/);
  });

  it("says the data was already copied once the seed marker exists", () => {
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "liveness.json"), "{}");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".seeded-from-legacy"), "{}");
    expect(stateDoctorLines(base())[0].hint).toMatch(/already copied.*squadrant migrate kb/);
  });

  it("ignores the legacy dir when it IS the state root (isolated SQUADRANT_CONFIG)", () => {
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "liveness.json"), "{}");
    expect(stateDoctorLines({ ...base(), root: legacy })).toEqual([]);
  });

  it("hints `squadrant heal daemon` while launchd still writes the legacy log path", () => {
    const lines = stateDoctorLines({ ...base(), loadedLogPath: "/old/squadrantd.log" });
    expect(lines).toEqual([expect.objectContaining({ ok: false, warnOnly: true, hint: expect.stringContaining("squadrant heal daemon") })]);
    expect(stateDoctorLines({ ...base(), loadedLogPath: "/x/logs/squadrantd.log" })).toEqual([]);
  });
});
