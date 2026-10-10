import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDefaultConfig } from "@squadrant/shared";
import { findLegacyKbs, moveLegacyKbs } from "../knowledge/index.js";

let root: string;
function cfg() {
  const c = getDefaultConfig();
  c.hubVault = path.join(root, "hub");
  c.knowledgeBases = { saitex: { path: path.join(root, "kb", "saitex") }, other: { path: path.join(root, "kb", "other") } };
  return c;
}
const legacy = (kb: string) => path.join(root, "hub", "knowledge", kb);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-migrate-"));
  fs.mkdirSync(path.join(legacy("saitex"), "rules", "coding"), { recursive: true });
  fs.writeFileSync(path.join(legacy("saitex"), "rules", "coding", "coding.a.md"), "x");
  fs.writeFileSync(path.join(legacy("saitex"), "sources.yaml"), "[]\n");
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe("moveLegacyKbs", () => {
  it("finds legacy KBs and does nothing on --dry-run", () => {
    expect(findLegacyKbs(cfg())).toEqual(["saitex"]);
    expect(moveLegacyKbs(cfg(), { dryRun: true })).toEqual([expect.objectContaining({ kb: "saitex", action: "would-move" })]);
    expect(fs.existsSync(legacy("saitex"))).toBe(true);
    expect(fs.existsSync(path.join(root, "kb", "saitex"))).toBe(false);
  });

  it("moves the KB to the new root, re-homes rules/ under shared/, git-inits, reports", () => {
    const [e] = moveLegacyKbs(cfg());
    expect(e).toMatchObject({ kb: "saitex", action: "moved", from: legacy("saitex"), to: path.join(root, "kb", "saitex") });
    expect(e.note).toContain("rules/ -> shared/rules/");
    expect(fs.readFileSync(path.join(root, "kb", "saitex", "shared", "rules", "coding", "coding.a.md"), "utf8")).toBe("x");
    expect(fs.existsSync(path.join(root, "kb", "saitex", ".git"))).toBe(true);
    expect(fs.existsSync(legacy("saitex"))).toBe(false); // renamed, not deleted: the content is at the target
  });

  it("never overwrites an existing target", () => {
    fs.mkdirSync(path.join(root, "kb", "saitex"), { recursive: true });
    const [e] = moveLegacyKbs(cfg());
    expect(e.action).toBe("skipped");
    expect(fs.existsSync(path.join(legacy("saitex"), "sources.yaml"))).toBe(true);
  });

  it("cross-device: copies and leaves the original in place", () => {
    const err = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw err; });
    const [e] = moveLegacyKbs(cfg());
    expect(e.action).toBe("copied");
    expect(e.note).toContain("original left in place");
    expect(fs.existsSync(path.join(legacy("saitex"), "sources.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "kb", "saitex", "sources.yaml"))).toBe(true);
  });

  it("reports nothing when there is no legacy dir", () => {
    fs.rmSync(path.join(root, "hub"), { recursive: true });
    expect(moveLegacyKbs(cfg())).toEqual([]);
  });
});
