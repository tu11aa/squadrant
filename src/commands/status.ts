import { Command } from "commander";
import chalk from "chalk";
import matter from "gray-matter";
import { loadConfig } from "@cockpit/shared";
import { createObsidianDriver, WorkspaceRegistry } from "@cockpit/workspaces";
import { queryHealth, printServiceHealth } from "./health-view.js";

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

function timeAgo(dateStr: string | undefined): string {
  if (!dateStr) return chalk.dim("—");
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return chalk.dim("—");

  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function progressBar(completed: number, total: number): string {
  if (total === 0) return chalk.dim("no tasks");
  const pct = Math.round((completed / total) * 100);
  const filled = Math.round(pct / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return `${bar} ${pct}%`;
}

export const statusCommand = new Command("status")
  .description("Show status of all projects from spoke vault status files")
  .option("--detailed", "also show live per-component service health from the daemon (#77)")
  .action(async (opts: { detailed?: boolean }) => {
    const config = loadConfig();
    const projects = Object.entries(config.projects);
    const registry = new WorkspaceRegistry({ obsidian: createObsidianDriver });

    if (projects.length === 0) {
      console.log(chalk.yellow("\nNo projects registered. Use: cockpit projects add <name> <path>\n"));
      return;
    }

    console.log(chalk.bold("\nProject Status\n"));
    console.log(
      chalk.dim(
        `  ${"PROJECT".padEnd(18)} ${"CAPTAIN".padEnd(12)} ${"CREW".padEnd(6)} ${"PROGRESS".padEnd(25)} LAST UPDATE`,
      ),
    );
    console.log(chalk.dim("  " + "─".repeat(85)));

    for (const [name, project] of projects) {
      const workspace = registry.forProject(name, config);

      if (!(await workspace.exists("status.md"))) {
        console.log(`  ${name.padEnd(18)} ${chalk.dim("no status.md")}`);
        continue;
      }

      let fm: StatusFrontmatter = {};
      try {
        const raw = await workspace.read("status.md");
        fm = matter(raw).data as StatusFrontmatter;
      } catch {
        console.log(`  ${name.padEnd(18)} ${chalk.red("error reading status.md")}`);
        continue;
      }

      const sessionIndicator =
        fm.captain_session === "active"
          ? chalk.green("●")
          : chalk.dim("○");
      const captainDisplay = `${project.captainName.padEnd(11)} ${sessionIndicator}`;
      const crew = String(fm.active_crew ?? 0).padEnd(6);
      const progress = progressBar(
        fm.tasks_completed ?? 0,
        fm.tasks_total ?? 0,
      ).padEnd(25);
      const updated = timeAgo(fm.last_updated);

      console.log(
        `  ${name.padEnd(18)} ${captainDisplay}  ${crew} ${progress} ${updated}`,
      );
    }

    console.log("");

    // #77: --detailed adds the live service-health view (relay/captain/crew/
    // command per-component last-seen + state) queried from the daemon.
    if (opts.detailed) {
      printServiceHealth(await queryHealth());
    }
  });
