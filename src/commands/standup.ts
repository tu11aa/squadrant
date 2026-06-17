import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import matter from "gray-matter";
import { loadConfig, resolveHome, type ProjectConfig, type CockpitConfig } from "@cockpit/shared";
import { readDailyLog, getGitCommits, iso, daysAgo } from "@cockpit/shared";
import { createObsidianDriver, WorkspaceRegistry } from "../workspaces/index.js";

interface StatusFrontmatter {
  project?: string;
  captain_session?: string;
  last_updated?: string;
  active_crew?: number;
  tasks_total?: number;
  tasks_completed?: number;
  tasks_in_progress?: number;
  tasks_pending?: number;
}

interface ProjectStandup {
  name: string;
  status: StatusFrontmatter;
  dailyLog: string | null;
  gitCommits: string[];
  blockers: string[];
}

function getDateStr(yesterday: boolean): string {
  return iso(daysAgo(yesterday ? 1 : 0));
}

async function getProjectStandup(
  name: string,
  project: ProjectConfig,
  dateStr: string,
  registry: WorkspaceRegistry,
  config: CockpitConfig,
): Promise<ProjectStandup> {
  const workspace = registry.forProject(name, config);
  // TODO(workspace): status.md still read via raw fs — migrate to workspace driver (see #24)
  const spokeVault = resolveHome(project.spokeVault);
  const statusFile = path.join(spokeVault, "status.md");

  let status: StatusFrontmatter = {};
  if (fs.existsSync(statusFile)) {
    try {
      status = matter(fs.readFileSync(statusFile, "utf-8")).data as StatusFrontmatter;
    } catch { /* empty */ }
  }

  const log = await readDailyLog(workspace, dateStr);
  const gitCommits = getGitCommits(project.path, dateStr);

  return {
    name,
    status,
    dailyLog: log?.content ?? null,
    gitCommits,
    blockers: log?.blockers ?? [],
  };
}

function formatStandup(standups: ProjectStandup[], dateStr: string, raw: boolean): string {
  const lines: string[] = [];
  const header = `Standup — ${dateStr}`;

  if (!raw) {
    lines.push(chalk.bold(`\n${header}\n`));
  } else {
    lines.push(`# ${header}\n`);
  }

  let hasBlockers = false;

  for (const s of standups) {
    const tasksDone = s.status.tasks_completed ?? 0;
    const tasksTotal = s.status.tasks_total ?? 0;
    const tasksInProgress = s.status.tasks_in_progress ?? 0;

    if (!raw) {
      lines.push(chalk.cyan.bold(`## ${s.name}`));
    } else {
      lines.push(`## ${s.name}`);
    }

    // What was done
    if (s.gitCommits.length > 0 || tasksDone > 0) {
      lines.push(!raw ? chalk.green("Done:") : "**Done:**");
      for (const commit of s.gitCommits) {
        lines.push(`  - ${commit}`);
      }
      if (tasksDone > 0 && s.gitCommits.length === 0) {
        lines.push(`  - ${tasksDone}/${tasksTotal} tasks completed`);
      }
    }

    // In progress
    if (tasksInProgress > 0) {
      lines.push(!raw ? chalk.yellow("In Progress:") : "**In Progress:**");
      lines.push(`  - ${tasksInProgress} task(s) active`);
    }

    // Extract sections from daily log
    if (s.dailyLog) {
      const sections = ["Completed", "In Progress", "Tomorrow"];
      for (const section of sections) {
        const match = s.dailyLog.match(new RegExp(`## ${section}\\n([\\s\\S]*?)(?=\\n##|$)`));
        if (match) {
          const items = match[1].trim().split("\n").filter((l) => l.trim().startsWith("-"));
          if (items.length > 0 && section === "Tomorrow") {
            lines.push(!raw ? chalk.blue("Next:") : "**Next:**");
            for (const item of items) lines.push(`  ${item.trim()}`);
          }
        }
      }
    }

    // Blockers
    if (s.blockers.length > 0) {
      hasBlockers = true;
      lines.push(!raw ? chalk.red("Blocked:") : "**Blocked:**");
      for (const b of s.blockers) {
        lines.push(`  - ${b}`);
      }
    }

    // No activity
    if (s.gitCommits.length === 0 && tasksDone === 0 && !s.dailyLog) {
      lines.push(!raw ? chalk.dim("  (no activity)") : "  (no activity)");
    }

    lines.push("");
  }

  // Summary line
  const totalCommits = standups.reduce((sum, s) => sum + s.gitCommits.length, 0);
  const totalDone = standups.reduce((sum, s) => sum + (s.status.tasks_completed ?? 0), 0);

  if (!raw) {
    lines.push(chalk.dim(`--- ${totalCommits} commits, ${totalDone} tasks done${hasBlockers ? ", HAS BLOCKERS" : ""} ---\n`));
  } else {
    lines.push(`---\n*${totalCommits} commits, ${totalDone} tasks done${hasBlockers ? ", HAS BLOCKERS" : ""}*\n`);
  }

  return lines.join("\n");
}

export const standupCommand = new Command("standup")
  .description("Generate daily standup report from spoke vault data and git logs (zero tokens)")
  .option("-p, --project <name>", "Show standup for a specific project only")
  .option("-a, --all", "Show all projects (default)")
  .option("-y, --yesterday", "Show yesterday's standup instead of today")
  .option("-r, --raw", "Output raw markdown (for pasting into Slack/chat)")
  .action(async (opts) => {
    const config = loadConfig();
    const registry = new WorkspaceRegistry({ obsidian: createObsidianDriver });
    const projects = Object.entries(config.projects);

    if (projects.length === 0) {
      console.log(chalk.yellow("\nNo projects registered. Use: cockpit projects add <name> <path>\n"));
      return;
    }

    const dateStr = getDateStr(!!opts.yesterday);
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

    const standups = await Promise.all(
      targets.map(([name, proj]) => getProjectStandup(name, proj, dateStr, registry, config)),
    );
    const output = formatStandup(standups, dateStr, raw);
    console.log(output);
  });
