import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SquadrantConfig } from "@squadrant/shared";
import { danglingRefs, refSites } from "../../lib/ref-sweep.js";
import { refDoctorLines } from "../doctor.js";

// #998: doctor's read-only dangling-reference check, over a hermetic HOME fixture.
describe("doctor dangling path references (#998)", () => {
  let home: string;
  let cfg: SquadrantConfig;
  const envKeys = ["SQUADRANT_NATIVE_MEMORY_ROOT", "SQUADRANT_WORKSPACE_DIR", "SQUADRANT_USER_KB_DIR"] as const;
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const h = (rel: string) => path.join(home, rel);
  const put = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(h(rel)), { recursive: true });
    fs.writeFileSync(h(rel), body);
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-doctor-refs-"));
    process.env.SQUADRANT_NATIVE_MEMORY_ROOT = h(".claude/projects");
    process.env.SQUADRANT_WORKSPACE_DIR = h("squadrant/workspace");
    process.env.SQUADRANT_USER_KB_DIR = h("squadrant/kb/_user");
    put("saitex/kb/archive/extracted-2026-10-13/pr-rules.md", "x");
    put(".claude/projects/-flooros/memory/lifecycle.md", [
      "PR rules: ~/saitex/kb/extracted/pr-rules.md §13",
      "now at ~/saitex/kb/archive/extracted-2026-10-13/pr-rules.md",
      "glob ~/saitex/kb/*.md and placeholder ~/squadrant/workspace/<p>/handoff.json and ~/x/{a,b}",
    ].join("\n"));
    put("squadrant/kb/saitex/shared/decisions/d1.md", "sources: [file:~/saitex/kb/extracted/gone.md]\n");
    put("squadrant/workspace/flooros/handoffs/2026-10-01.json", '{"old": "~/gone/archived-only"}'); // archived: ignored
    cfg = { projects: {}, knowledgeBases: { saitex: { path: h("squadrant/kb/saitex") } } } as unknown as SquadrantConfig;
  });

  afterEach(() => {
    for (const k of envKeys) process.env[k] = saved[k];
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reports a dangling ~/ ref in a memory file and in a KB decision; ignores globs, placeholders and archived handoffs", () => {
    const refs = danglingRefs(refSites(cfg, home), home);
    expect(refs.map((r) => [r.site, path.relative(home, r.file), r.line, r.ref])).toEqual([
      ["memory:claude", ".claude/projects/-flooros/memory/lifecycle.md", 1, "~/saitex/kb/extracted/pr-rules.md"],
      ["kb", "squadrant/kb/saitex/shared/decisions/d1.md", 1, "~/saitex/kb/extracted/gone.md"],
    ]);

    const lines = refDoctorLines(refs);
    expect(lines.map((l) => l.label)).toEqual(["1 dangling path reference(s) in memory:claude", "1 dangling path reference(s) in kb"]);
    expect(lines[0].items).toEqual([`${h(".claude/projects/-flooros/memory/lifecycle.md")}:1  ~/saitex/kb/extracted/pr-rules.md`]);
    expect(lines[0].hint).toContain("squadrant migrate path");
  });

  it("lists at most `limit` per site, with a pointer to --verbose", () => {
    const refs = Array.from({ length: 7 }, (_, i) => ({ site: "kb", file: "/f.md", line: i + 1, ref: `~/x${i}` }));
    expect(refDoctorLines(refs)[0].items).toHaveLength(6);
    expect(refDoctorLines(refs)[0].items[5]).toBe("… and 2 more (squadrant doctor --verbose lists all)");
    expect(refDoctorLines(refs, Infinity)[0].items).toHaveLength(7);
  });
});
