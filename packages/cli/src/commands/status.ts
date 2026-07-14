import { Command } from "commander";
import chalk from "chalk";
import matter from "gray-matter";
import { loadConfig } from "@squadrant/shared";
import { createObsidianDriver, WorkspaceRegistry } from "@squadrant/workspaces";
import { queryHealth, printServiceHealth } from "./health-view.js";
import type { ComponentHealth } from "@squadrant/core";

interface StatusFrontmatter {
  project?: string;
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

/**
 * Pure. Render the captain liveness indicator from the daemon's registry-derived
 * state (#538) — never from status.md, which nothing writes to.
 * `undefined` means the daemon returned no entry for this project (never
 * registered / not yet probed); together with "unknown" it renders "?" rather
 * than the offline glyph, since asserting offline on missing data is a false
 * negative (#538's core ask).
 */
export function captainIndicator(state: ComponentHealth["state"] | undefined): string {
  if (state === "alive" || state === "stale") return chalk.green("●");
  if (state === undefined || state === "unknown") return chalk.dim("?");
  return chalk.dim("○");
}

/**
 * Pure. Render one project's status row. status.md is an optional human note
 * layered on top of daemon-derived captain liveness (#549) — a project with
 * no status.md (or an unparseable one) still renders with its real captain
 * state, rather than being dropped from the table entirely.
 */
export function formatProjectRow(
  name: string,
  captainName: string,
  fm: StatusFrontmatter,
  hasStatusMd: boolean,
  captainState: ComponentHealth["state"] | undefined,
): string {
  const sessionIndicator = captainIndicator(captainState);
  const captainDisplay = `${captainName.padEnd(11)} ${sessionIndicator}`;
  const crew = hasStatusMd ? String(fm.active_crew ?? 0).padEnd(6) : chalk.dim("?").padEnd(6);
  const progress = hasStatusMd
    ? progressBar(fm.tasks_completed ?? 0, fm.tasks_total ?? 0).padEnd(25)
    : chalk.dim("no notes").padEnd(25);
  const updated = hasStatusMd ? timeAgo(fm.last_updated) : chalk.dim("—");

  return `  ${name.padEnd(18)} ${captainDisplay}  ${crew} ${progress} ${updated}`;
}

export const statusCommand = new Command("status")
  .description("Show status of all projects from spoke vault status files")
  .option("--detailed", "also show live per-component service health from the daemon (#77)")
  .action(async (opts: { detailed?: boolean }) => {
    const config = loadConfig();
    const projects = Object.entries(config.projects);
    const registry = new WorkspaceRegistry({ obsidian: createObsidianDriver });

    if (projects.length === 0) {
      console.log(chalk.yellow("\nNo projects registered. Use: squadrant projects add <name> <path>\n"));
      return;
    }

    // Ground-truth captain liveness comes from the daemon's LivenessRegistry
    // (#538) — status.md's `captain_session` frontmatter is written by nothing
    // and was always stale/absent, producing false "offline" reads for captains
    // that were demonstrably alive. `null` means the daemon is unreachable —
    // liveness is genuinely unknown, not offline (#538's core ask).
    const health = await queryHealth();
    const captainStateByProject = new Map<string, ComponentHealth["state"]>();
    if (health) {
      for (const c of health) {
        if (c.kind === "captain") captainStateByProject.set(c.project, c.state);
      }
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

      let fm: StatusFrontmatter = {};
      let hasStatusMd = false;
      if (await workspace.exists("status.md")) {
        try {
          const raw = await workspace.read("status.md");
          fm = matter(raw).data as StatusFrontmatter;
          hasStatusMd = true;
        } catch {
          // Unreadable status.md — fall through and render with hasStatusMd=false
          // so the row still shows live captain state instead of being dropped.
        }
      }

      console.log(
        formatProjectRow(name, project.captainName, fm, hasStatusMd, captainStateByProject.get(name)),
      );
    }

    console.log("");

    // #77: --detailed adds the live service-health view (relay/captain/crew/
    // command per-component last-seen + state) queried from the daemon.
    if (opts.detailed) {
      printServiceHealth(health);
    }
  });
