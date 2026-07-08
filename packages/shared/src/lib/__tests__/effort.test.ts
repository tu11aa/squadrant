import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveEffort, getDefaultConfig, saveProjectOverride } from "@squadrant/shared";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sq-effort-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("resolveEffort — global only", () => {
  it("returns 'balance' when effort is absent", () => {
    const config = getDefaultConfig();
    delete (config.defaults as any).effort;
    expect(resolveEffort(config)).toBe("balance");
  });

  it("returns 'max' when explicitly set to max", () => {
    const config = getDefaultConfig();
    (config.defaults as any).effort = "max";
    expect(resolveEffort(config)).toBe("max");
  });

  it("returns 'balance' when explicitly set to balance", () => {
    const config = getDefaultConfig();
    (config.defaults as any).effort = "balance";
    expect(resolveEffort(config)).toBe("balance");
  });

  it("returns 'low' when explicitly set to low", () => {
    const config = getDefaultConfig();
    (config.defaults as any).effort = "low";
    expect(resolveEffort(config)).toBe("low");
  });
});

describe("resolveEffort — per-project override", () => {
  it("per-project override wins over global", () => {
    saveProjectOverride("my-proj", { effort: "low" }, root);
    const config = getDefaultConfig();
    (config.defaults as any).effort = "max";
    expect(resolveEffort(config, "my-proj", root)).toBe("low");
  });

  it("no per-project override falls back to global", () => {
    saveProjectOverride("my-proj", {}, root);
    const config = getDefaultConfig();
    (config.defaults as any).effort = "max";
    expect(resolveEffort(config, "my-proj", root)).toBe("max");
  });

  it("absent per-project file falls back to global", () => {
    const config = getDefaultConfig();
    (config.defaults as any).effort = "low";
    expect(resolveEffort(config, "nonexistent", root)).toBe("low");
  });

  it("per-project override with no global effort uses override directly", () => {
    saveProjectOverride("my-proj", { effort: "low" }, root);
    const config = getDefaultConfig();
    delete (config.defaults as any).effort;
    expect(resolveEffort(config, "my-proj", root)).toBe("low");
  });

  it("no override and no global falls back to 'balance'", () => {
    const config = getDefaultConfig();
    delete (config.defaults as any).effort;
    expect(resolveEffort(config, "my-proj", root)).toBe("balance");
  });
});
