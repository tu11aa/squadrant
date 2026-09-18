import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Sidecar marker written into every squadrant-managed opencode skill dir. Its
 * presence is what lets the sync refresh/prune squadrant's own skills while
 * leaving a user's hand-written opencode skills untouched.
 */
export const OPENCODE_SKILL_MARKER = ".squadrant-managed";

const MARKER_BODY = "squadrant\n";

export interface OpencodeSkillsSyncResult {
  written: string[];
  unchanged: string[];
  removed: string[];
  skipped: Array<{ name: string; reason: "foreign-collision" }>;
}

export interface SyncOpencodeSkillsOptions {
  /** Shipped skills dir (e.g. `<pkgRoot>/plugin/skills`). */
  sourceSkillsDir: string;
  /** opencode's global skills dir (e.g. `~/.config/opencode/skills`). */
  skillsRoot: string;
  dryRun?: boolean;
}

/**
 * opencode's global skills dir — one of its documented discovery locations
 * (`~/.config/opencode/skills/<name>/SKILL.md`). `XDG_CONFIG_HOME` is honored
 * the same way opencode honors it.
 */
export function defaultOpencodeSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", "skills");
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Minimal frontmatter read — only enough to know opencode can load the skill. */
function parseSkillName(raw: string): string | null {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) return null;
  return name;
}

function listSourceSkills(sourceSkillsDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(sourceSkillsDir)) return out;
  for (const entry of fs.readdirSync(sourceSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(sourceSkillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const name = parseSkillName(fs.readFileSync(skillPath, "utf-8"));
    if (name && SAFE_NAME.test(name)) out.set(name, skillPath);
  }
  return out;
}

function hasMarker(dir: string): boolean {
  return fs.existsSync(path.join(dir, OPENCODE_SKILL_MARKER));
}

/**
 * Project the shipped skills (verbatim, so opencode parses the exact
 * frontmatter it was authored with) into opencode's global skills dir, refresh
 * changed ones, and prune squadrant-managed skills that a newer version no
 * longer ships. Foreign (unmarked) skill dirs are never touched — a name
 * collision is reported as a skip rather than a clobber.
 *
 * Idempotent: unchanged skills are left untouched. Best called on every CLI
 * invocation / daemon boot so the projection can't drift from the shipped
 * `plugin/skills/`.
 */
export function syncOpencodeSkills(opts: SyncOpencodeSkillsOptions): OpencodeSkillsSyncResult {
  const result: OpencodeSkillsSyncResult = { written: [], unchanged: [], removed: [], skipped: [] };
  const wanted = listSourceSkills(opts.sourceSkillsDir);

  // A missing source is a no-op, never a blind prune: a broken install path
  // must not wipe whatever the user already has.
  if (wanted.size === 0 && !fs.existsSync(opts.sourceSkillsDir)) return result;

  if (!opts.dryRun) fs.mkdirSync(opts.skillsRoot, { recursive: true });

  for (const [name, srcPath] of wanted) {
    const targetDir = path.join(opts.skillsRoot, name);
    const targetSkill = path.join(targetDir, "SKILL.md");
    const managed = hasMarker(targetDir);

    if (fs.existsSync(targetSkill) && !managed) {
      // Written by the user, not squadrant — never overwrite it.
      result.skipped.push({ name, reason: "foreign-collision" });
      continue;
    }

    const current = fs.existsSync(targetSkill) ? fs.readFileSync(targetSkill) : null;
    if (current && current.equals(fs.readFileSync(srcPath))) {
      if (!managed && !opts.dryRun) {
        fs.writeFileSync(path.join(targetDir, OPENCODE_SKILL_MARKER), MARKER_BODY);
      }
      result.unchanged.push(name);
      continue;
    }

    if (!opts.dryRun) {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(srcPath, targetSkill);
      fs.writeFileSync(path.join(targetDir, OPENCODE_SKILL_MARKER), MARKER_BODY);
    }
    result.written.push(name);
  }

  if (fs.existsSync(opts.skillsRoot)) {
    for (const entry of fs.readdirSync(opts.skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || wanted.has(entry.name)) continue;
      const dir = path.join(opts.skillsRoot, entry.name);
      if (!hasMarker(dir)) continue; // foreign — leave it alone
      if (!opts.dryRun) fs.rmSync(dir, { recursive: true, force: true });
      result.removed.push(entry.name);
    }
  }

  return result;
}

/**
 * Resolve the shipped skills from a package root and sync them into opencode's
 * global skills dir. Convenience wrapper for the CLI/daemon call sites.
 */
export function syncShippedOpencodeSkills(opts: {
  pkgRoot: string;
  skillsRoot?: string;
  dryRun?: boolean;
}): OpencodeSkillsSyncResult {
  return syncOpencodeSkills({
    sourceSkillsDir: path.join(opts.pkgRoot, "plugin", "skills"),
    skillsRoot: opts.skillsRoot ?? defaultOpencodeSkillsRoot(),
    dryRun: opts.dryRun,
  });
}
