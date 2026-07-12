import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import {
  loadConfig,
  saveConfig,
  resolveEffort,
  loadProjectOverride,
  saveProjectOverride,
  DEFAULT_CONFIG_PATH,
} from "@squadrant/shared";
import type { SquadrantConfig, Effort } from "@squadrant/shared";
import { appendCaptainMessage } from "@squadrant/core";

const VALID_EFFORTS: Effort[] = ["max", "balance", "low"];

const EFFORT_MEANING: Record<Effort, string> = {
  max: "tokens are plentiful — bias crew spawns toward claude/opus",
  balance: "normal routing — use default crew routing rules unchanged",
  low: "conserve tokens — bias crew spawns toward opencode/sonnet; reserve opus for work that genuinely needs it",
};

export interface EffortGetResult {
  effort: Effort;
  description: string;
}

export function runEffortGet(configPath = DEFAULT_CONFIG_PATH, projectName?: string): EffortGetResult {
  const config = loadConfig(configPath);
  const effort = resolveEffort(config, projectName);
  const description = `${effort}: ${EFFORT_MEANING[effort]}`;
  return { effort, description };
}

/**
 * Set the effort dial. With `projectName`, writes a per-project override
 * (projects/<name>.json) instead of the global dial — the two scopes are
 * mutually exclusive so callers must not fall through to the global write.
 */
export function runEffortSet(
  value: string,
  configPath = DEFAULT_CONFIG_PATH,
  projectName?: string,
  projectConfigRoot?: string,
): void {
  if (!(VALID_EFFORTS as string[]).includes(value)) {
    throw new Error(
      `Invalid effort '${value}'. Valid values: ${VALID_EFFORTS.join(" | ")}`,
    );
  }
  if (projectName) {
    const config = loadConfig(configPath);
    if (!(projectName in config.projects)) {
      const known = Object.keys(config.projects).sort().join(", ") || "(no projects registered)";
      throw new Error(`Unknown project '${projectName}'. Known projects: ${known}`);
    }
    saveProjectOverride(projectName, { effort: value as Effort }, projectConfigRoot);
    return;
  }
  const config = loadConfig(configPath);
  config.defaults.effort = value as Effort;
  saveConfig(config, configPath);
}

/** Scope label for the CLI success line — must state what was actually written (#575). */
export function effortScopeLabel(projectName?: string): string {
  return projectName ? `project: ${projectName}` : "global";
}

/** Minimal slice of RuntimeDriver used to resolve captain status. */
interface EffortNotifyDriver {
  status(nameOrId: string): Promise<{ id: string } | null>;
}

/** Resolve a path through symlinks; fall back to a plain resolve if it
 *  doesn't exist on disk (e.g. a stale/unmounted project entry). */
function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Send the effort-change notice to every running captain whose *effective*
 * effort actually changed, via the mailbox. The captain that ran
 * `squadrant effort` already saw stdout, so that project is excluded.
 * Routes through the mailbox so the daemon's delivery-loop drains it with
 * draft protection (#529).
 * appendCaptainMessage is a closure capturing stateRoot from the caller.
 *
 * `scopeProject` set means the write was project-scoped (#575): only that
 * project's effective effort changed, so only it is notified. Unset means a
 * global write: projects with their own override are unaffected and must be
 * skipped rather than told a value that isn't theirs (#576).
 */
export async function notifyCaptainsOfEffort(
  effort: Effort,
  config: SquadrantConfig,
  driver: EffortNotifyDriver,
  cwd: string = process.cwd(),
  append: (project: string, text: string) => Promise<void | number>,
  scopeProject?: string,
  projectConfigRoot?: string,
): Promise<void> {
  const here = canonical(cwd);
  const notice = `🎚️ effort → ${effort}: ${EFFORT_MEANING[effort]}`;
  for (const [projName, proj] of Object.entries(config.projects)) {
    // Skip the captain running in this same directory — it already saw stdout.
    if (canonical(proj.path) === here) continue;

    if (scopeProject) {
      if (projName !== scopeProject) continue;
    } else if (loadProjectOverride(projName, projectConfigRoot).effort !== undefined) {
      // This project pins its own effort — the global change doesn't apply to it.
      continue;
    }

    try {
      const ref = await driver.status(proj.captainName);
      if (ref) {
        await append(projName, notice);
      }
    } catch {
      // individual project captain unreachable — skip
    }
  }
}

export const effortCommand = new Command("effort")
  .description("Get or set the crew tokenomics dial (max | balance | low) — global by default, or per-project with --project")
  .argument("[value]", "effort level to set: max | balance | low")
  .option("--project <name>", "target a specific project (get: show its resolved effort; set: write a per-project override)")
  .action(async (value: string | undefined, options: { project?: string }) => {
    if (value === undefined) {
      const { effort, description } = runEffortGet(undefined, options.project);
      const label = options.project ? `${options.project} project` : "global";
      console.log(chalk.bold(`Current effort (${label}):`), chalk.cyan(effort));
      console.log(chalk.dim(EFFORT_MEANING[effort]));
      return;
    }

    try {
      runEffortSet(value, undefined, options.project);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }

    const effort = value as Effort;
    console.log(chalk.green(`✔ effort → ${effort} (${effortScopeLabel(options.project)})`));
    console.log(chalk.dim(EFFORT_MEANING[effort]));

    // Best-effort active notify: enqueue to the mailbox for every running captain
    // whose effective effort actually changed. Never hard-fails — config is
    // already written above.
    // Routes through the mailbox (not driver.send) to avoid clobbering user draft (#529).
    try {
      const { createCmuxDriver, RuntimeRegistry } = await import("@squadrant/workspaces");
      const config = loadConfig();
      const registry = new RuntimeRegistry({ cmux: createCmuxDriver() });
      const driver = registry.global(config);
      const stateRoot = path.join(path.dirname(DEFAULT_CONFIG_PATH), "state");
      const append = (project: string, text: string) =>
        appendCaptainMessage({ stateRoot, project, text, source: "daemon" });
      await notifyCaptainsOfEffort(effort, config, driver, process.cwd(), append, options.project);
    } catch {
      // runtime unavailable — config already written, change applies on next launch
      console.log(chalk.dim("(no running captain detected — change applies on next launch)"));
    }
  });
