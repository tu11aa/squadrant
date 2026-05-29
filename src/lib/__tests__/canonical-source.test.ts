import { describe, it, expect } from "vitest";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import { readUserLevelSource, readProjectLevelSource } from "../canonical-source.js";
import { createObsidianDriver } from "../../workspaces/index.js";
import type { WorkspaceDriver } from "../../workspaces/types.js";

function memDriver(files: Record<string, string>): WorkspaceDriver {
  return {
    name: "memory",
    async probe() {
      return { installed: true, rootExists: true };
    },
    async read(p: string) {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    async write(p: string, c: string) {
      files[p] = c;
    },
    async exists(p: string) {
      if (p in files) return true;
      const prefix = p.endsWith("/") ? p : p + "/";
      return Object.keys(files).some((k) => k.startsWith(prefix));
    },
    async list(p: string) {
      const prefix = p.endsWith("/") ? p : p + "/";
      const entries = new Set<string>();
      for (const key of Object.keys(files)) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          entries.add(rest.split("/")[0]);
        }
      }
      return Array.from(entries);
    },
    async mkdir() {},
  };
}

describe("canonical-source", () => {
  it("readUserLevelSource inlines every plugin/skills/*/SKILL.md", async () => {
    const driver = memDriver({
      "plugin/skills/karpathy-principles/SKILL.md":
        "---\nname: karpathy-principles\ndescription: K desc\n---\n\nK body",
      "plugin/skills/captain-ops/SKILL.md":
        "---\nname: captain-ops\ndescription: C desc\n---\n\nC body",
    });
    const src = await readUserLevelSource(driver);
    expect(src.skills.map((s) => s.name).sort()).toEqual(["captain-ops", "karpathy-principles"]);
    const k = src.skills.find((s) => s.name === "karpathy-principles")!;
    expect(k.description).toBe("K desc");
    expect(k.content).toContain("K body");
  });

  it("readUserLevelSource does NOT include cockpit's own AGENTS.md", async () => {
    const driver = memDriver({
      "AGENTS.md": "# Cockpit-specific content\ngitnexus stuff",
      "plugin/skills/karpathy-principles/SKILL.md":
        "---\nname: karpathy-principles\ndescription: K\n---\n\nK body",
    });
    const src = await readUserLevelSource(driver);
    expect(src.instructions).toBe("");
    expect(src.skills.map((s) => s.name)).toEqual(["karpathy-principles"]);
  });

  it("readUserLevelSource returns empty skills when plugin/skills is missing", async () => {
    const driver = memDriver({});
    const src = await readUserLevelSource(driver);
    expect(src.skills).toEqual([]);
    expect(src.instructions).toBe("");
  });

  it("readProjectLevelSource returns null when AGENTS.md is absent", async () => {
    const driver = memDriver({});
    const src = await readProjectLevelSource(driver);
    expect(src).toBeNull();
  });

  it("readProjectLevelSource reads AGENTS.md when present", async () => {
    const driver = memDriver({
      "AGENTS.md": "# Brove rules\nuse design tokens",
    });
    const src = await readProjectLevelSource(driver);
    expect(src).not.toBeNull();
    expect(src!.instructions).toContain("Brove rules");
  });

  it("readProjectLevelSource inlines project-local plugin/skills if present", async () => {
    const driver = memDriver({
      "AGENTS.md": "# Brove",
      "plugin/skills/brove-style/SKILL.md":
        "---\nname: brove-style\ndescription: BS\n---\n\nBS body",
    });
    const src = await readProjectLevelSource(driver);
    expect(src!.skills.map((s) => s.name)).toEqual(["brove-style"]);
  });

  // Regression: project-scope projection silently skipped every managed project
  // whose path was not under the cockpit repo, because the source-reading driver
  // was rooted at process.cwd() and the obsidian sandbox guard rejected the
  // absolute out-of-cwd project path. readProjectLevelSource must read a project
  // whose directory lives OUTSIDE process.cwd().
  it("readProjectLevelSource reads a project rooted outside process.cwd()", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cockpit-proj-"));
    try {
      await fsp.writeFile(path.join(tmp, "AGENTS.md"), "# OnePlan rules\nuse design tokens");
      await fsp.mkdir(path.join(tmp, "plugin/skills/op-style"), { recursive: true });
      await fsp.writeFile(
        path.join(tmp, "plugin/skills/op-style/SKILL.md"),
        "---\nname: op-style\ndescription: OP\n---\n\nOP body",
      );
      expect(tmp.startsWith(process.cwd())).toBe(false);
      const driver = createObsidianDriver({ root: tmp });
      const src = await readProjectLevelSource(driver);
      expect(src).not.toBeNull();
      expect(src!.instructions).toContain("OnePlan rules");
      expect(src!.skills.map((s) => s.name)).toEqual(["op-style"]);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("skips SKILL.md files with missing frontmatter", async () => {
    const driver = memDriver({
      "plugin/skills/broken/SKILL.md": "no frontmatter here\njust body",
    });
    const src = await readUserLevelSource(driver);
    expect(src.skills).toEqual([]);
  });
});

describe("readUserLevelSource — role template inlining (#45)", () => {
  it("inlines captain.generic.md and crew.generic.md when pkgRoot is provided", async () => {
    const driver = memDriver({
      "plugin/skills/karpathy-principles/SKILL.md":
        "---\nname: karpathy-principles\ndescription: K\n---\n\nK body",
    });
    const reads: string[] = [];
    const readFile = (p: string): string => {
      reads.push(p);
      if (p.endsWith("captain.generic.md")) return "# Captain — Generic Agent\n\nrules...";
      if (p.endsWith("crew.generic.md"))    return "# Crew Member — Generic Agent\n\nrules...";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };

    const src = await readUserLevelSource(driver, { pkgRoot: "/pkg", readFile });

    expect(src.instructions).toContain("## Captain Role");
    expect(src.instructions).toContain("Captain — Generic Agent");
    expect(src.instructions).toContain("## Crew Role");
    expect(src.instructions).toContain("Crew Member — Generic Agent");
    expect(src.skills.map((s) => s.name)).toEqual(["karpathy-principles"]);
    expect(reads).toContain("/pkg/orchestrator/captain.generic.md");
    expect(reads).toContain("/pkg/orchestrator/crew.generic.md");
  });

  it("emits role sections in fixed order: captain then crew", async () => {
    const driver = memDriver({});
    const readFile = (p: string): string => {
      if (p.endsWith("captain.generic.md")) return "CAP";
      if (p.endsWith("crew.generic.md"))    return "CRW";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    const src = await readUserLevelSource(driver, { pkgRoot: "/pkg", readFile });
    const capIdx = src.instructions.indexOf("## Captain Role");
    const crwIdx = src.instructions.indexOf("## Crew Role");
    expect(capIdx).toBeGreaterThanOrEqual(0);
    expect(crwIdx).toBeGreaterThan(capIdx);
  });

  it("returns instructions='' when pkgRoot is omitted (back-compat)", async () => {
    const driver = memDriver({
      "plugin/skills/karpathy-principles/SKILL.md":
        "---\nname: karpathy-principles\ndescription: K\n---\n\nK body",
    });
    const src = await readUserLevelSource(driver);
    expect(src.instructions).toBe("");
    expect(src.skills.map((s) => s.name)).toEqual(["karpathy-principles"]);
  });

  it("omits a role section when its template is missing on disk", async () => {
    const driver = memDriver({});
    const readFile = (p: string): string => {
      if (p.endsWith("captain.generic.md")) return "CAP only";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    const src = await readUserLevelSource(driver, { pkgRoot: "/pkg", readFile });
    expect(src.instructions).toContain("## Captain Role");
    expect(src.instructions).not.toContain("## Crew Role");
  });

  it("returns instructions='' when both templates are missing", async () => {
    const driver = memDriver({});
    const readFile = (): string => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    const src = await readUserLevelSource(driver, { pkgRoot: "/pkg", readFile });
    expect(src.instructions).toBe("");
  });

  it("trims trailing whitespace inside each role section", async () => {
    const driver = memDriver({});
    const readFile = (p: string): string => {
      if (p.endsWith("captain.generic.md")) return "captain body\n\n\n";
      if (p.endsWith("crew.generic.md"))    return "crew body\n";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    const src = await readUserLevelSource(driver, { pkgRoot: "/pkg", readFile });
    expect(src.instructions).not.toMatch(/\n{4,}/);
  });
});
