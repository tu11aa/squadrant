import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("config-io", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-config-io-"));
  const configBase = path.join(tmpDir, ".config", "squadrant");

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== "darwin")("tightens permissions correctly via migration", async () => {
    vi.doMock("../../config.js", () => ({
      CONFIG_DIR: configBase,
      DEFAULT_CONFIG_PATH: path.join(configBase, "config.json")
    }));

    const { migrateConfigPermsSync } = await import("../config-io.js");

    fs.mkdirSync(configBase, { recursive: true, mode: 0o755 });
    const file = path.join(configBase, "config.json");
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    
    migrateConfigPermsSync();
    
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(configBase).mode & 0o777).toBe(0o700);
    vi.doUnmock("../../config.js");
  });

  it.skipIf(process.platform !== "darwin")("writeConfigFileSync sets strict modes and tightens parents", async () => {
    vi.doMock("../../config.js", () => ({
      CONFIG_DIR: configBase,
      DEFAULT_CONFIG_PATH: path.join(configBase, "config.json")
    }));

    const { writeConfigFileSync } = await import("../config-io.js");

    const file2 = path.join(configBase, "projects", "proj.json");
    writeConfigFileSync(file2, "{}");
    
    expect(fs.statSync(file2).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file2)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(configBase).mode & 0o777).toBe(0o700);
    vi.doUnmock("../../config.js");
  });
});
