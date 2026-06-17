import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { ensureSocketAutomation } from "../cmux-config.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmux-cfg-"));
  path = join(dir, "cmux.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ensureSocketAutomation", () => {
  it("creates a minimal cockpit-managed file when none exists", () => {
    const r = ensureSocketAutomation({ path });
    expect(r.changed).toBe(true);
    expect(r.alreadySet).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(parse(readFileSync(path, "utf-8")).automation.socketControlMode).toBe("automation");
  });

  it("is a no-op when already set to automation", () => {
    writeFileSync(
      path,
      `{\n  // keep me\n  "automation": { "socketControlMode": "automation" }\n}\n`,
    );
    const before = readFileSync(path, "utf-8");
    const r = ensureSocketAutomation({ path });
    expect(r.changed).toBe(false);
    expect(r.alreadySet).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(before); // byte-identical, untouched
  });

  it("preserves comments and existing keys when adding the automation key", () => {
    const original = [
      `{`,
      `  "$schema": "https://example/cmux.schema.json",`,
      `  // a leading comment that MUST survive`,
      `  "schemaVersion": 1,`,
      ``,
      `  // a trailing comment`,
      `}`,
      ``,
    ].join("\n");
    writeFileSync(path, original);

    const r = ensureSocketAutomation({ path });
    expect(r.changed).toBe(true);
    expect(r.alreadySet).toBe(false);

    const after = readFileSync(path, "utf-8");
    expect(after).toContain("// a leading comment that MUST survive");
    expect(after).toContain("// a trailing comment");
    expect(after).toContain(`"$schema"`);
    const parsed = parse(after);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.automation.socketControlMode).toBe("automation");
  });

  it("overwrites a non-automation mode (e.g. cmuxOnly) and preserves siblings", () => {
    writeFileSync(
      path,
      `{\n  // hi\n  "automation": { "socketControlMode": "cmuxOnly", "other": true }\n}\n`,
    );
    const r = ensureSocketAutomation({ path });
    expect(r.changed).toBe(true);
    expect(r.alreadySet).toBe(false);
    const parsed = parse(readFileSync(path, "utf-8"));
    expect(parsed.automation.socketControlMode).toBe("automation");
    expect(parsed.automation.other).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("// hi");
  });

  it("is idempotent across repeated calls", () => {
    ensureSocketAutomation({ path });
    const first = readFileSync(path, "utf-8");
    const r2 = ensureSocketAutomation({ path });
    expect(r2.changed).toBe(false);
    expect(r2.alreadySet).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(first);
  });
});
