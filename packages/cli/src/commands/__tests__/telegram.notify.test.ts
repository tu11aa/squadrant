import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { loadProjectOverride } from "@squadrant/shared";
import { runTelegramNotifyPref } from "../telegram.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "sq-tn-")); });

describe("runTelegramNotifyPref", () => {
  it("writes crew tier to the override file", () => {
    expect(runTelegramNotifyPref({ project: "p", dimension: "crew", value: "all", root })).toEqual({ ok: true });
    expect(loadProjectOverride("p", root)).toEqual({ telegram: { notify: { crew: "all" } } });
  });
  it("rejects a bad crew tier", () => {
    expect(runTelegramNotifyPref({ project: "p", dimension: "crew", value: "loud", root }).ok).toBe(false);
  });
  it("writes cap on/off as boolean", () => {
    runTelegramNotifyPref({ project: "p", dimension: "cap", value: "off", root });
    expect(loadProjectOverride("p", root)).toEqual({ telegram: { notify: { cap: false } } });
  });
});
