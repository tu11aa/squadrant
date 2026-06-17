import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import matter from "gray-matter";
import { loadConfig, resolveHome, type ProjectConfig, type CockpitConfig } from "@cockpit/shared";
import {
  readDailyLog,
  parseSection,
  getGitCommitsInRange,
  getMergedPRsInRange,
  enumerateDays,
  iso,
  daysAgo,
} from "@cockpit/shared";
import { createObsidianDriver, WorkspaceRegistry } from "../workspaces/index.js";

interface StatusFrontmatter {
  tasks_total?: number;
  tasks_completed?: number;
  tasks_in_progress?: number;
}

interface ProjectRetro {
  name: string;
  shipped: string[];
  inProgress: string[];
  blocked: string[];
  decisions: string[];
  commits: string[];
  mergedPRs: string[];
  tasksCompletedNow: number;
  tasksInProgressNow: number;
}

// TODO(workspace): status.md still read via raw fs — migrate to workspace driver (see #24)
function readStatus(spokeVault: string): StatusFrontmatter {
  const statusFile = path.join(spokeVault, "status.md");
  if (!fs.existsSync(statusFile)) return {};
  try {
    return matter(fs.readFileSync(statusFile, "utf-8")).data as StatusFrontmatter;
  } catch {
    return {};
  }
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

async function getProjectRetro(
  name: string,
  project: ProjectConfig,
  fromStr: string,
  toStr: string,
  registry: WorkspaceRegistry,
  config: CockpitConfig,
): Promise<ProjectRetro> {
  const workspace = registry.forProject(name, config);
  const spokeVault = resolveHome(project.spokeVault);
  const status = readStatus(spokeVault);

  const shipped: string[] = [];
  const inProgress: string[] = [];
  const blocked: string[] = [];
  const decisions: string[] = [];

  for (const day of enumerateDays(new Date(fromStr), new Date(toStr))) {
    const log = await readDailyLog(workspace, day);
    if (!log) continue;
    shipped.push(...parseSection(log.content, "Completed"));
    inProgress.push(...parseSection(log.content, "In Progress"));
    blocked.push(...log.blockers);
    decisions.push(...parseSection(log.content, "Decisions"));
  }

  const commits = getGitCommitsInRange(
    project.path,
    `${fromStr} 00:00:00`,
    `${toStr} 23:59:59`,
  );
  const mergedPRs = getMergedPRsInRange(
    project.path,
    `${fromStr} 00:00:00`,
    `${toStr} 23:59:59`,
  );

  return {
    name,
    shipped: dedupe(shipped),
    inProgress: dedupe(inProgress),
    blocked: dedupe(blocked),
    decisions: dedupe(decisions),
    commits,
    mergedPRs,
    tasksCompletedNow: status.tasks_completed ?? 0,
    tasksInProgressNow: status.tasks_in_progress ?? 0,
  };
}

function renderList(lines: string[], items: string[], raw: boolean, label: string, color: (s: string) => string) {
  if (items.length === 0) return;
  lines.push(raw ? `**${label}:**` : color(`${label}:`));
  for (const it of items) lines.push(`  - ${it}`);
}

function formatRetro(retros: ProjectRetro[], fromStr: string, toStr: string, raw: boolean): string {
  const lines: string[] = [];
  const header = `Retro — ${fromStr} → ${toStr}`;
  lines.push(raw ? `# ${header}\n` : chalk.bold(`\n${header}\n`));

  let totalCommits = 0;
  let totalPRs = 0;
  let totalShipped = 0;

  for (const r of retros) {
    totalCommits += r.commits.length;
    totalPRs += r.mergedPRs.length;
    totalShipped += r.shipped.length;

    lines.push(raw ? `## ${r.name}` : chalk.cyan.bold(`## ${r.name}`));

    renderList(lines, r.shipped, raw, "Shipped", chalk.green);
    if (r.mergedPRs.length > 0) {
      lines.push(raw ? `**PRs merged:**` : chalk.green("PRs merged:"));
      for (const pr of r.mergedPRs) lines.push(`  - ${pr}`);
    }
    renderList(lines, r.inProgress, raw, "In Progress", chalk.yellow);
    renderList(lines, r.blocked, raw, "Blocked", chalk.red);
    renderList(lines, r.decisions, raw, "Key Decisions", chalk.magenta);

    const metricBits = [
      `${r.commits.length} commits`,
      `${r.mergedPRs.length} PRs merged`,
      `${r.shipped.length} shipped`,
    ];
    lines.push(raw ? `*${metricBits.join(" · ")}*` : chalk.dim(`  ${metricBits.join(" · ")}`));

    if (
      r.shipped.length === 0 &&
      r.commits.length === 0 &&
      r.mergedPRs.length === 0 &&
      r.inProgress.length === 0 &&
      r.blocked.length === 0
    ) {
      lines.push(raw ? "_(no activity in this window)_" : chalk.dim("  (no activity in this window)"));
    }

    lines.push("");
  }

  const summary = `${totalShipped} items shipped · ${totalCommits} commits · ${totalPRs} PRs merged`;
  lines.push(raw ? `---\n*${summary}*\n` : chalk.dim(`--- ${summary} ---\n`));

  return lines.join("\n");
}

export const retroCommand = new Command("retro")
  .description("Generate a retro (weekly/sprint summary) from daily logs and git (zero tokens)")
  .option("-w, --week", "Trailing 7 days (default)")
  .option("-s, --sprint [days]", "Custom window of N days (default 14 if N omitted)")
  .option("-p, --project <name>", "Retro for a single project")
  .option("-a, --all", "All projects (default)")
  .option("-r, --raw", "Raw markdown output (for pasting into Slack/Obsidian)")
  .action(async (opts) => {
    const config = loadConfig();
    const registry = new WorkspaceRegistry({ obsidian: createObsidianDriver });
    const projects = Object.entries(config.projects);

    if (projects.length === 0) {
      console.log(chalk.yellow("\nNo projects registered. Use: cockpit projects add <name> <path>\n"));
      return;
    }

    let windowDays = 7;
    if (opts.sprint !== undefined) {
      const parsed = typeof opts.sprint === "string" ? parseInt(opts.sprint, 10) : NaN;
      windowDays = Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
    } else if (opts.week) {
      windowDays = 7;
    }

    const toStr = iso(new Date());
    const fromStr = iso(daysAgo(windowDays - 1));
    const raw = !!opts.raw;

    let targets: [string, ProjectConfig][];
    if (opts.project) {
      const match = projects.find(([name]) => name === opts.project);
      if (!match) {
        console.error(chalk.red(`Project "${opts.project}" not found.`));
        process.exit(1);
      }
      targets = [match];
    } else {
      targets = projects;
    }

    const retros = await Promise.all(
      targets.map(([name, proj]) => getProjectRetro(name, proj, fromStr, toStr, registry, config)),
    );
    console.log(formatRetro(retros, fromStr, toStr, raw));
  });
