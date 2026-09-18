import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  syncOpencodeSkills,
  syncShippedOpencodeSkills,
  defaultOpencodeSkillsRoot,
  OPENCODE_SKILL_MARKER,
} from "../opencode-skills.js";

let tmp: string;
let src: string;
let dest: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-oc-skills-"));
  src = path.join(tmp, "src");
  dest = path.join(tmp, "dest");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function skillMd(name: string, description: string, body = "body"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function addSourceSkill(name: string, body = "body"): void {
  write(path.join(src, name, "SKILL.md"), skillMd(name, `${name} desc`, body));
}

function read(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

describe("syncOpencodeSkills", () => {
  it("emits each loadable source skill as <skillsRoot>/<name>/SKILL.md verbatim", () => {
    addSourceSkill("captain-ops");
    addSourceSkill("karpathy-principles");

    const result = syncOpencodeSkills({ sourceSkillsDir: src, skillsRoot: dest });

    expect(result.written.sort()).toEqual(["captain-ops", "karpathy-principles"]);
    expect(read(path.join(dest, "captain-ops", "SKILL.md"))).toBe(
      read(path.join(src, "captain-ops", "SKILL.md")),
    );
    expect(fs.existsSync(path.join(dest, "captain-ops", OPENCODE_SKILL_MARKER))).toBe(true);
  });

  it("skips source skills without a loadable name/description frontmatter", () => {
    addSourceSkill("captain-ops");
    write(path.join(src, "takeover", "SKILL.md"), "# Takeover\n\nno frontmatter\n");
    write(path.join(src, "not-a-skill", "README.md"), "ignored");

    const result = syncOpencodeSkills({ sourceSkillsDir: src, skillsRoot: dest });

    expect(result.written).toEqual(["captain-ops"]);
    expect(fs.existsSync(path.join(dest, "takeover"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "not-a-skill"))).toBe(false);
  });

  it("is idempotent — a second run writes nothing and removes nothing", () => {
    addSourceSkill("captain-ops");
    syncOpencodeSkills({ sourceSkillsDir: src, skillsRoot: dest });

    const second = syncOpencodeSkills({ sourceSkillsDir: src, skillsRoot: dest });

    expect(second.written).toEqual([]);
    expect(second.removed).toEqual([]);
    expect(second.unchanged).toEqual(["captain-ops"]);
  });

  it("refreshes a managed skill whose content changed upstream", () => {
    addSourceSkill("captain-ops", "old body");
    syncOpencodeSkills({ sourceSkillsDir: src, skillsRoot: dest });

    addSourceSkill("captain-ops", "new body");
    const result = syncOpencodeSkills({ sourceSkillsDir: src, skillsRoot: dest });

    expect(result.written).toEqual(["captain-ops"]);
    expect(read(path.join(dest, "captain-ops", "SKILL.md"))).toContain("new body");
  });

  it("prunes a stale managed skill removed from the shipped source", () => {
    addSourceSkill("captain-ops");
    addSourceSkill("old-skill");
    syncOpencodeSkills({ sourceSkillsDir: src, skillsRoot: dest });
    expect(fs.existsSync(path.join(dest, "old-skill"))).toBe(true);

    fs.rmSync(path.join(src, "old-skill"), { recursive: true });
    const result = syncOpencodeSkills({ sourceSkillsDir: src, skillsRoot: dest });

    expect(result.removed).toEqual(["old-skill"]);
    expect(fs.existsSync(path.join(dest, "old-skill"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "captain-ops"))).toBe(true);
  });

  it("never deletes a foreign skill (no squadrant marker)", () => {
    addSourceSkill("captain-ops");
    write(path.join(dest, "my-own-skill", "SKILL.md"), skillMd("my-own-skill", "mine"));

    const result = syncOpencodeSkills({ sourceSkillsDir: src, skillsRoot: dest });

    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(dest, "my-own-skill", "SKILL.md"))).toBe(true);
  });

  it("does not clobber a foreign skill that collides on name", () => {
    addSourceSkill("captain-ops");
    write(path.join(dest, "captain-ops", "SKILL.md"), skillMd("captain-ops", "user's own"));

    const result = syncOpencodeSkills({ sourceSkillsDir: src, skillsRoot: dest });

    expect(result.skipped).toEqual([{ name: "captain-ops", reason: "foreign-collision" }]);
    expect(result.written).toEqual([]);
    expect(read(path.join(dest, "captain-ops", "SKILL.md"))).toContain("user's own");
  });

  it("dryRun reports the delta without touching disk", () => {
    addSourceSkill("captain-ops");
    addSourceSkill("stale");

    const plan = syncOpencodeSkills({ sourceSkillsDir: src, skillsRoot: dest, dryRun: true });
    expect(plan.written.sort()).toEqual(["captain-ops", "stale"]);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("is a no-op when the source skills dir is missing (never prunes blind)", () => {
    write(path.join(dest, "captain-ops", "SKILL.md"), skillMd("captain-ops", "x"));
    write(path.join(dest, "captain-ops", OPENCODE_SKILL_MARKER), "squadrant\n");

    const result = syncOpencodeSkills({
      sourceSkillsDir: path.join(tmp, "does-not-exist"),
      skillsRoot: dest,
    });

    expect(result.written).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(dest, "captain-ops"))).toBe(true);
  });
});

describe("defaultOpencodeSkillsRoot", () => {
  it("defaults to ~/.config/opencode/skills", () => {
    expect(defaultOpencodeSkillsRoot({})).toBe(
      path.join(os.homedir(), ".config", "opencode", "skills"),
    );
  });

  it("honors XDG_CONFIG_HOME", () => {
    expect(defaultOpencodeSkillsRoot({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      path.join("/xdg", "opencode", "skills"),
    );
  });
});

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "plugin", "skills", "captain-ops", "SKILL.md"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error("repo root with plugin/skills not found");
}

describe("syncShippedOpencodeSkills (repo integration, standalone temp target)", () => {
  it("projects the shipped loadable skills and skips the frontmatter-less ones", () => {
    const result = syncShippedOpencodeSkills({ pkgRoot: findRepoRoot(), skillsRoot: dest });

    expect(result.written).toContain("captain-ops");
    expect(result.written).toContain("karpathy-principles");
    // handback / takeover ship without name+description frontmatter — opencode
    // cannot load them, so they must not be projected.
    expect(result.written).not.toContain("takeover");
    expect(result.written).not.toContain("handback");
    expect(fs.existsSync(path.join(dest, "captain-ops", "SKILL.md"))).toBe(true);
  });
});
