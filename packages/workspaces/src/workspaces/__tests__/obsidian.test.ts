import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createObsidianDriver } from "../obsidian.js";

describe("ObsidianDriver", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("has name 'obsidian'", () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    expect(driver.name).toBe("obsidian");
  });

  it("probe returns installed=true and rootExists=true for a real dir", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.rootExists).toBe(true);
  });

  it("probe returns rootExists=false when scope root is missing", async () => {
    const missing = path.join(tmpRoot, "does-not-exist");
    const driver = createObsidianDriver({ root: missing });
    const result = await driver.probe();
    expect(result.installed).toBe(true);
    expect(result.rootExists).toBe(false);
  });

  it("write then read round-trips content", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    await driver.mkdir("daily-logs");
    await driver.write("daily-logs/2026-04-21.md", "hello world");
    const content = await driver.read("daily-logs/2026-04-21.md");
    expect(content).toBe("hello world");
  });

  it("exists returns true/false correctly", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    await driver.write("a.txt", "x");
    expect(await driver.exists("a.txt")).toBe(true);
    expect(await driver.exists("b.txt")).toBe(false);
  });

  it("list returns entry names only (not paths)", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    await driver.mkdir("crew");
    await driver.write("crew/one.md", "1");
    await driver.write("crew/two.md", "2");
    const entries = await driver.list("crew");
    expect(entries.sort()).toEqual(["one.md", "two.md"]);
  });

  it("list returns empty array for missing directory", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    const entries = await driver.list("nope");
    expect(entries).toEqual([]);
  });

  it("mkdir is always recursive", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    await driver.mkdir("a/b/c/d");
    expect(fs.existsSync(path.join(tmpRoot, "a/b/c/d"))).toBe(true);
  });

  it("write creates parent directories", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    await driver.write("deep/nested/file.txt", "data");
    expect(fs.readFileSync(path.join(tmpRoot, "deep/nested/file.txt"), "utf-8")).toBe("data");
  });

  it("scope-rooted paths never escape root (no path traversal via ../)", async () => {
    const driver = createObsidianDriver({ root: tmpRoot });
    await expect(driver.read("../../etc/passwd")).rejects.toThrow(/escapes workspace root/i);
    await expect(driver.write("../evil.txt", "x")).rejects.toThrow(/escapes workspace root/i);
  });
});
