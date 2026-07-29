import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "@squadrant/shared";
import { queryHealth, printServiceHealth } from "./health-view.js";
import type { ComponentHealth } from "@squadrant/core";

/**
 * Pure. Render the captain liveness indicator from the daemon's registry-derived
 * state (#538) — never from status.md, which nothing writes to.
 * `undefined` means the daemon returned no entry for this project (never
 * registered / not yet probed); together with "unknown" it renders "?" rather
 * than the offline glyph, since asserting offline on missing data is a false
 * negative (#538's core ask).
 * "stopped" (deliberate, clean shutdown) gets its own magenta glyph, distinct
 * from "gone" (crashed / dark past the gone window — a genuine fault) — see
 * liveness.ts's #324 comment ("clean close — magenta, not a fault"). Collapsing
 * both into the same dim ○ left the operator unable to tell "I stopped this"
 * from "this died on me" (#549).
 */
export function captainIndicator(state: ComponentHealth["state"] | undefined): string {
  if (state === "alive" || state === "stale") return chalk.green("●");
  if (state === "stopped") return chalk.magenta("⏻");
  if (state === undefined || state === "unknown") return chalk.dim("?");
  return chalk.dim("○");
}

/**
 * Pure. Render one project's status row — captain liveness only. Task/crew
 * counts used to come from status.md, but nothing writes that file (the
 * write-status.sh it depended on doesn't exist) — rather than render stale
 * or fabricated numbers, this command doesn't claim to have them (#630).
 */
export function formatProjectRow(
  name: string,
  captainName: string,
  captainState: ComponentHealth["state"] | undefined,
): string {
  const sessionIndicator = captainIndicator(captainState);
  const captainDisplay = `${captainName.padEnd(11)} ${sessionIndicator}`;
  return `  ${name.padEnd(18)} ${captainDisplay}`;
}

export const statusCommand = new Command("status")
  .description("Show captain liveness for all projects (task/crew counts have no data source — #630)")
  .option("--detailed", "also show live per-component service health from the daemon (#77)")
  .action(async (opts: { detailed?: boolean }) => {
    const config = loadConfig();
    const projects = Object.entries(config.projects);

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
    console.log(chalk.dim(`  ${"PROJECT".padEnd(18)} CAPTAIN`));
    console.log(chalk.dim("  " + "─".repeat(35)));

    for (const [name, project] of projects) {
      console.log(formatProjectRow(name, project.captainName, captainStateByProject.get(name)));
    }

    console.log(chalk.dim("\n  Task/crew counts: no data source yet — see squadrant/squadrant#630\n"));

    // #77: --detailed adds the live service-health view (relay/captain/crew/
    // command per-component last-seen + state) queried from the daemon.
    if (opts.detailed) {
      printServiceHealth(health);
    }
  });
