import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { saveProjectOverride } from "@squadrant/shared";
import { capAllowed } from "../telegram.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "sq-ts-")); });

describe("capAllowed", () => {
  it("defaults to true (built-in cap=true)", () => {
    expect(capAllowed("p", undefined, root)).toBe(true);
  });
  it("project cap=false suppresses captain sends", () => {
    saveProjectOverride("p", { telegram: { notify: { cap: false } } }, root);
    expect(capAllowed("p", undefined, root)).toBe(false);
  });
});
