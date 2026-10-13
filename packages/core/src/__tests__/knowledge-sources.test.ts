import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import matter from "gray-matter";
import { loadRulesDir, loadSources, removeSource, SOURCES_TEMPLATE } from "../knowledge/index.js";

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

describe("removeSource (lifecycle spec §6.2 step 3)", () => {
  const kb = () => path.join(hub, "saitex");
  const rulesDir = () => path.join(kb(), "shared", "rules");
  const SOURCES = "# trusted sources\n- path: extracted/**\n  priority: project\n  domain: coding\n- path: raw/**\n  priority: agent # keep\n  review: required\n";
  const rule = (id: string, refs: string[], status = "active") => {
    const src = refs.map((r) => `  - { ref: ${r}, sha: abc, quote: "q" }`).join("\n");
    fs.mkdirSync(path.join(rulesDir(), "coding"), { recursive: true });
    fs.writeFileSync(path.join(rulesDir(), "coding", `${id}.md`), `---\nid: ${id}\ndomain: coding\nmodality: must\nstatus: ${status}\nsources:\n${src}\n---\nS ${id}.\n`);
  };
  const seed = () => {
    write(SOURCES);
    rule("coding.only-extracted", ["extracted/coding.md"]);
    rule("coding.both", ["extracted/pr.md", "raw/onb.html"]);
    rule("coding.raw-only", ["raw/onb.html"]);
  };
  const snapshot = () => [fs.readFileSync(path.join(kb(), "sources.yaml"), "utf8"), ...fs.readdirSync(path.join(rulesDir(), "coding")).map((f) => fs.readFileSync(path.join(rulesDir(), "coding", f), "utf8"))];
  const byId = () => Object.fromEntries(loadRulesDir(rulesDir(), "kb:t").rules.map((r) => [r.id, r]));

  it("--dry-run reports the effect and writes nothing", () => {
    seed();
    const before = snapshot();
    const r = removeSource(kb(), rulesDir(), "extracted/**", { dryRun: true });
    expect(r).toMatchObject({ dryRun: true, entryRemoved: true, stripped: ["coding.both", "coding.only-extracted"], stale: ["coding.only-extracted"] });
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(kb(), "index.json"))).toBe(false);
  });

  it("strips refs, marks source-less rules stale, leaves multi-source rules active, keeps other entries and comments", () => {
    seed();
    const r = removeSource(kb(), rulesDir(), "extracted/**");
    expect(r.stale).toEqual(["coding.only-extracted"]);
    const rules = byId();
    expect(rules["coding.only-extracted"]).toMatchObject({ status: "stale", sources: [] });
    expect(rules["coding.both"]).toMatchObject({ status: "active" });
    expect(rules["coding.both"].sources.map((s) => s.ref)).toEqual(["raw/onb.html"]);
    expect(rules["coding.raw-only"].sources.map((s) => s.ref)).toEqual(["raw/onb.html"]);
    expect(fs.readFileSync(path.join(kb(), "sources.yaml"), "utf8")).toBe("# trusted sources\n- path: raw/**\n  priority: agent # keep\n  review: required\n");
    expect(loadSources(kb()).sources.map((s) => s.path)).toEqual(["raw/**"]);
    expect(JSON.parse(fs.readFileSync(path.join(kb(), "index.json"), "utf8")).rules.map((x: { id: string }) => x.id).sort()).toEqual(["coding.both", "coding.only-extracted", "coding.raw-only"]);
    expect(matter(fs.readFileSync(path.join(rulesDir(), "coding", "coding.both.md"), "utf8")).data.id).toBe("coding.both");
  });

  it("matches absolute and ~ refs against the entry glob", () => {
    write("- path: ~/saitex-x/extracted/**\n  priority: project\n");
    rule("coding.abs", [`${path.join(require("node:os").homedir(), "saitex-x/extracted/a.md")}`]);
    rule("coding.tilde", ["~/saitex-x/extracted/b.md"]);
    expect(removeSource(kb(), rulesDir(), "~/saitex-x/extracted/**", { dryRun: true }).stripped).toEqual(["coding.abs", "coding.tilde"]);
  });

  it("an unknown entry is an error and changes nothing", () => {
    seed();
    const before = snapshot();
    expect(() => removeSource(kb(), rulesDir(), "nope/**")).toThrow(/no sources\.yaml entry/);
    expect(snapshot()).toEqual(before);
  });

  it("leaves already-stale or retired rules' status alone", () => {
    seed();
    rule("coding.old", ["extracted/x.md"], "retired");
    removeSource(kb(), rulesDir(), "extracted/**");
    expect(byId()["coding.old"]).toMatchObject({ status: "retired", sources: [] });
  });
});
