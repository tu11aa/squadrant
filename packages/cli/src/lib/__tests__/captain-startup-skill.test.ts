import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// #1142 / #1109: a captain loads captain-startup + the captain-ops core at startup; the core's single
// trigger table must keep every reference file and every skill captain-ops names reachable.
const root = path.resolve(__dirname, "../../../../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf-8");
const opsDir = "plugin/skills/captain-ops";
const startup = read("plugin/skills/captain-startup/SKILL.md");
const core = read(`${opsDir}/SKILL.md`);
const refFiles = fs.readdirSync(path.join(root, opsDir)).filter((f) => f.endsWith(".md") && f !== "SKILL.md").sort();
const allOps = [core, ...refFiles.map((f) => read(`${opsDir}/${f}`))].join("\n");
const table = core.slice(core.indexOf("## Trigger table"));

describe("captain-startup + captain-ops core", () => {
  it("startup stays small: both files together under 4 KB tokens' worth (~16 KB)", () => {
    expect(Buffer.byteLength(startup)).toBeLessThan(3 * 1024);
    expect(Buffer.byteLength(startup) + Buffer.byteLength(core)).toBeLessThan(10 * 1024);
  });

  it("the trigger table lives only in the core", () => {
    expect(startup).not.toContain("| Before you");
    expect(refFiles.length).toBeGreaterThan(0);
    for (const f of refFiles) expect(read(`${opsDir}/${f}`)).not.toContain("| Before you");
  });

  it.each(refFiles)("the trigger table names reference file %s", (f) => {
    expect(table).toContain(`\`${f}\``);
  });

  it("names every skill that the old captain-ops pointed to", () => {
    for (const s of ["prompt-master", "karpathy-principles", "rules-ops", "human-review-guide", "daily-log", "wiki-ops", "add-pick-crew-rule", "set-effort", "rollover", "restart"]) {
      expect(table, s).toContain(s);
    }
    const refs = new Set([...allOps.matchAll(/squadrant:([a-z-]+)/g)].map((m) => m[1]).filter((n) => n !== "captain-startup" && n !== "captain-ops"));
    for (const name of refs) expect(table, name).toContain(name);
  });

  it("every file or skill the table names exists", () => {
    for (const m of table.matchAll(/`([a-z-]+\.md)`/g)) expect(refFiles, m[1]).toContain(m[1]);
    for (const m of table.matchAll(/squadrant:([a-z-]+)/g)) expect(fs.existsSync(path.join(root, "plugin/skills", m[1], "SKILL.md")), m[1]).toBe(true);
  });

  it("the init prompt and the captain templates send a captain to captain-startup", () => {
    expect(read("packages/cli/src/commands/launch.ts")).toContain("use the squadrant:captain-startup skill");
    expect(read("scripts/spawn-workspace.sh")).toContain("use the squadrant:captain-startup skill");
    expect(read("templates/captain.claude.md")).toContain("Load `squadrant:captain-startup`");
  });
});
