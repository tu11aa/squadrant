import fs from "node:fs";
import path from "node:path";
import type { WorkspaceDriver } from "../workspaces/types.js";
import type { ProjectionSource } from "../projection/types.js";

interface SkillFrontmatter {
  name: string;
  description: string;
}

function parseSkill(raw: string): { frontmatter: SkillFrontmatter; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const [, fmBlock, body] = match;
  const fm: Partial<SkillFrontmatter> = {};
  for (const line of fmBlock.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) (fm as Record<string, string>)[kv[1]] = kv[2].trim();
  }
  if (!fm.name || !fm.description) return null;
  return { frontmatter: fm as SkillFrontmatter, body: body.trim() };
}

async function readSkills(
  driver: WorkspaceDriver,
  skillsDir: string,
): Promise<ProjectionSource["skills"]> {
  if (!(await driver.exists(skillsDir))) return [];
  const names = await driver.list(skillsDir);
  const skills: ProjectionSource["skills"] = [];
  for (const name of names) {
    const skillPath = `${skillsDir}/${name}/SKILL.md`;
    if (!(await driver.exists(skillPath))) continue;
    const raw = await driver.read(skillPath);
    const parsed = parseSkill(raw);
    if (!parsed) continue;
    skills.push({
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      content: parsed.body,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

export interface UserSourceOptions {
  pkgRoot?: string;
  readFile?: (p: string) => string;
}

const ROLE_TEMPLATES: ReadonlyArray<{ file: string; heading: string }> = [
  { file: "captain.generic.md", heading: "## Captain Role" },
  { file: "crew.generic.md",    heading: "## Crew Role" },
];

function readRoleTemplates(opts: UserSourceOptions): string {
  if (!opts.pkgRoot) return "";
  const reader = opts.readFile ?? ((p: string) => fs.readFileSync(p, "utf-8"));
  const sections: string[] = [];
  for (const { file, heading } of ROLE_TEMPLATES) {
    const full = path.join(opts.pkgRoot, "orchestrator", file);
    let body = "";
    try { body = reader(full); } catch { continue; }
    sections.push(`${heading}\n\n${body.trim()}`);
  }
  return sections.join("\n\n");
}

export async function readUserLevelSource(
  driver: WorkspaceDriver,
  opts: UserSourceOptions = {},
): Promise<ProjectionSource> {
  const skills = await readSkills(driver, "plugin/skills");
  const instructions = readRoleTemplates(opts);
  return { instructions, skills };
}

export async function readProjectLevelSource(
  driver: WorkspaceDriver,
  projectRoot: string,
): Promise<ProjectionSource | null> {
  const agentsPath = `${projectRoot}/AGENTS.md`;
  if (!(await driver.exists(agentsPath))) return null;
  const instructions = await driver.read(agentsPath);
  const skills = await readSkills(driver, `${projectRoot}/plugin/skills`);
  return { instructions, skills };
}
