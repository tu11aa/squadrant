import { Command } from "commander";
import { execSync } from "node:child_process";
import fs from "node:fs";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import { readAllStatuses } from "../dashboard/read-status.js";
import { renderDashboard } from "../dashboard/render.js";
import { syncHub, type SyncHubResult } from "../dashboard/sync-hub.js";
import type { PaneRef } from "../runtimes/types.js";
import { resolveCmuxBin } from "../lib/cmux-bin.js";

// TODO(runtime): current-workspace not yet abstracted by RuntimeDriver — direct cmux call retained,
// matching the existing pattern in src/commands/command.ts.
function detectCurrentWorkspace(): string {
  const out = execSync(`"${resolveCmuxBin()}" current-workspace`, { encoding: "utf-8" }).trim();
  const match = out.match(/workspace:\d+/);
  if (!match) {
    throw new Error("Could not detect current cmux workspace. Run `cockpit dashboard --pane` from inside a cmux workspace.");
  }
  return match[0];
}

export interface DashboardOnceDeps {
  readFile?: (path: string) => string;
  now?: () => string;
  write?: (s: string) => void;
}

export function runDashboardOnce(deps: DashboardOnceDeps = {}): void {
  const config = loadConfig();
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf-8"));
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const write = deps.write ?? ((s) => process.stdout.write(s));

  const statuses = readAllStatuses({ config, readFile });
  const width = process.stdout.columns ?? 100;
  write(renderDashboard(statuses, { now, width }));
  write("\n");
}

export interface SyncHubCliDeps {
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
  mkdir?: (path: string) => void;
}

export function runSyncHub(deps: SyncHubCliDeps = {}): SyncHubResult[] {
  const config = loadConfig();
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf-8"));
  const statuses = readAllStatuses({ config, readFile });
  return syncHub({ config, statuses, writeFile: deps.writeFile, mkdir: deps.mkdir });
}

export interface DashboardPaneInput {
  direction?: "right" | "left" | "up" | "down";
  interval?: number;
}

export async function runDashboardPane(input: DashboardPaneInput): Promise<PaneRef> {
  const config = loadConfig();
  const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).global(config);
  const workspaceId = detectCurrentWorkspace();

  const interval = input.interval ?? 10;
  const direction = input.direction ?? "right";
  const title = "📊 dashboard";

  // Portable refresh loop — no `watch` install dependency.
  // FORCE_COLOR=1 makes chalk emit ANSI even when run through the loop.
  const loop = `clear; while true; do clear; FORCE_COLOR=1 cockpit dashboard --once; sleep ${interval}; done`;

  const pane = await runtime.newPane({ workspaceId, direction, title });
  await runtime.sendToPane(pane, loop);
  return pane;
}

export const dashboardCommand = new Command("dashboard")
  .description("Live status grid of all projects (auto-derived from spoke status.md)")
  .option("--once", "Print one snapshot and exit (used by --pane's refresh loop)")
  .option("--pane", "Open a refreshing sidebar pane in the current cmux workspace")
  .option("--direction <dir>", "Pane split direction (right|left|up|down)", "right")
  .option("--interval <seconds>", "Refresh interval for --pane", (v) => parseInt(v, 10), 10)
  .action(async (opts: { once?: boolean; pane?: boolean; direction: "right" | "left" | "up" | "down"; interval: number }) => {
    try {
      if (opts.pane) {
        const pane = await runDashboardPane({ direction: opts.direction, interval: opts.interval });
        console.log(chalk.green(`✔ Dashboard pane opened in ${pane.workspaceId} ${pane.surfaceId}`));
        return;
      }
      // Default behaviour: --once. (Bare `cockpit dashboard` prints once and exits.)
      runDashboardOnce();
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

dashboardCommand
  .command("sync-hub")
  .description("Mirror each spoke status.md into {hubVault}/projects/<name>.md for Obsidian Dataview")
  .option("--json", "Emit results as JSON")
  .action((opts: { json?: boolean }) => {
    const results = runSyncHub();
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    if (results.length === 0) {
      console.log(chalk.dim("\n  No mirrors written (no projects with usable status.md, or hubVault unset).\n"));
      return;
    }
    console.log(chalk.bold("\n  📊 Hub mirror sync\n"));
    for (const r of results) {
      console.log(`  ${chalk.green("✔")} ${chalk.cyan(r.project.padEnd(16))} → ${chalk.dim(r.hubPath)}`);
    }
    console.log("");
  });
