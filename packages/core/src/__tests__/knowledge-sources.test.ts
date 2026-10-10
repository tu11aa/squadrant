import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSources, SOURCES_TEMPLATE } from "../knowledge/index.js";

let hub: string;
const write = (text: string) => {
  fs.mkdirSync(path.join(hub, "saitex"), { recursive: true });
  fs.writeFileSync(path.join(path.join(hub, "saitex"), "sources.yaml"), text);
};
beforeEach(() => { hub = fs.mkdtempSync(path.join(os.tmpdir(), "kb-src-")); });
afterEach(() => fs.rmSync(hub, { recursive: true, force: true }));

describe("loadSources", () => {
  it("missing file → empty", () => {
    expect(loadSources(path.join(hub, "saitex"))).toEqual({ sources: [], errors: [] });
  });
  it("template parses to an empty list", () => {
    write(SOURCES_TEMPLATE);
    expect(loadSources(path.join(hub, "saitex"))).toEqual({ sources: [], errors: [] });
  });
  it("loads valid entries and reports invalid ones by index", () => {
    write(`- path: raw/finance/**\n  priority: company\n- path: raw/x.pdf\n  priority: boss\n- path: raw/c/**\n  priority: company\n  sensitivity: local-only\n`);
    const r = loadSources(path.join(hub, "saitex"));
    expect(r.sources.map((s) => s.path)).toEqual(["raw/finance/**", "raw/c/**"]);
    expect(r.errors).toEqual([expect.stringMatching(/^entry 1: priority/)]);
  });
  it("non-list YAML is an error, not a throw", () => {
    write("path: oops\n");
    expect(loadSources(path.join(hub, "saitex")).errors[0]).toContain("must be a YAML list");
  });
  it("invalid YAML is an error, not a throw", () => {
    write("- path: [unclosed\n");
    expect(loadSources(path.join(hub, "saitex")).errors[0]).toContain("YAML parse error");
  });
});
