// src/commands/launch.ts
//
// Thin wrapper: parse args → construct CLI-edge deps → call launchOneWorkspace → format.
// Workspace-boot orchestration lives in @squadrant/core (launch-workspace.ts, #367).

import { Command } from "commander";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig, resolveHome, ensureSpokeLayout } from "@squadrant/shared";
import type { ModelRoutingConfig } from "@squadrant/shared";
import {
  createClaudeDriver, createCodexDriver, createGeminiDriver, createOpencodeDriver,
  CapabilityRegistry, buildAgentCmd,
} from "@squadrant/agents";
import {
  RuntimeRegistry, createCmuxDriver, createObsidianDriver, WorkspaceRegistry,
  isInsideCmux, cmuxLocal, classifyStartupSurface,
} from "@squadrant/workspaces";
import { launchOneWorkspace, loadSessions } from "@squadrant/core";
import { selectCaptainsInteractive } from "./launch-interactive.js";
import type { CaptainEntry } from "./launch-interactive.js";

// Re-export for test-import stability (launch.test.ts imports from ../launch.js).
export { deliverStartupPrompt } from "@squadrant/core";
export type { StartupDeliveryOptions } from "@squadrant/core";

const CMUX_APP = "/Applications/cmux.app";
const TEMPLATES_DIR = path.join(os.homedir(), ".config", "squadrant", "templates");
const SESSIONS_PATH = path.join(os.homedir(), ".config", "squadrant", "sessions.json");

function ensureCmuxReady(): void {
  if (isInsideCmux()) return;

  console.log(chalk.yellow("\n  Not running inside cmux. Opening cmux app...\n"));
  execSync(`open "${CMUX_APP}"`, { stdio: "inherit" });
  console.log(chalk.bold("  Run `squadrant launch` from inside a cmux workspace.\n"));
  process.exit(0);
}

export const launchCommand = new Command("launch")
  .description(
    "Launch a project captain (with project arg) or all captains (--all). Use `squadrant command` for one-shot Command tasks.",
  )
  .argument("[project]", "Project name to launch captain for")
  .option("--fresh", "Start a new session instead of resuming the last one")
  .option("--all", "Launch all captain workspaces")
  .action(async (project: string | undefined, opts: { fresh?: boolean; all?: boolean }) => {
    const config = loadConfig();

    // Build agent driver registry
    const drivers = {
      claude: createClaudeDriver(),
      codex: createCodexDriver(),
      gemini: createGeminiDriver(),
      opencode: createOpencodeDriver(),
    };
    const registry = new CapabilityRegistry(drivers);

    // Build runtime driver registry
    const runtimes = new RuntimeRegistry({ cmux: createCmuxDriver() });

    async function launchOne(
      workspaceName: string,
      role: string,
      cwd: string,
      permissionMode: string,
      navigate: boolean,
      pinToTop = false,
      projectName?: string,
    ): Promise<void> {
      ensureCmuxReady();

      const roleConfig = config.defaults.roles?.[role as keyof NonNullable<typeof config.defaults.roles>];
      const agentName = roleConfig?.agent || "claude";
      const model = roleConfig?.model || config.defaults.models?.[role as keyof ModelRoutingConfig];

      let initialPrompt: string | undefined;
      if (role === "captain") {
        initialPrompt = "Run your startup checklist: use the squadrant:captain-ops skill, complete all startup steps, then report ready.";
      } else if (role === "command") {
        initialPrompt = "Run your startup checklist: use the squadrant:command-ops skill, complete your daily briefing, then report ready.";
      }

      const runtime = projectName
        ? runtimes.forProject(projectName, config)
        : runtimes.global(config);

      try {
        await launchOneWorkspace({
          workspaceName,
          role,
          cwd,
          forceFreshOverride: opts.fresh,
          sessionsPath: SESSIONS_PATH,
          templatesDir: TEMPLATES_DIR,
          agentCmdFactory: (forceFresh) =>
            buildAgentCmd(agentName, registry, role, forceFresh, permissionMode, model, TEMPLATES_DIR),
          initialPrompt,
          runtime,
          navigate,
          pinToTop,
          classifyScreen: classifyStartupSurface,
          selectWorkspace: (id) => cmuxLocal(["select-workspace", "--workspace", id]),
          getCurrentWorkspace: () => {
            try {
              return cmuxLocal(["current-workspace"]);
            } catch { return null; }
          },
          onFreshReason: (reason) => console.log(chalk.cyan(`  ↻ ${reason}`)),
          onStoppingStale: (name) => console.log(chalk.yellow(`  Closing stale workspace '${name}' for fresh start`)),
          onAlreadyExists: (name) => console.log(chalk.yellow(`  Workspace '${name}' already exists — switching to it`)),
          onCreated: (name) => console.log(chalk.green(`  ✔ Workspace '${name}' created`)),
        });
      } catch (err) {
        console.error(chalk.red(`  ✘ Failed: ${(err as Error).message}`));
      }
    }

    if (opts.all) {
      // Launch all captains. Command is no longer auto-launched (#42).
      const hubPath = resolveHome(config.hubVault);
      fs.mkdirSync(hubPath, { recursive: true });

      console.log(chalk.bold("\nLaunching all captain workspaces\n"));

      for (const [name, proj] of Object.entries(config.projects)) {
        const projPath = resolveHome(proj.path);
        const spokePath = resolveHome(proj.spokeVault);
        if (!fs.existsSync(spokePath)) {
          const spokeDriver = new WorkspaceRegistry({ obsidian: createObsidianDriver }).forProject(name, config);
          await ensureSpokeLayout(spokeDriver);
          console.log(chalk.cyan(`  ✔ Created spoke vault at ${spokePath}`));
        }
        console.log(chalk.bold(`\n  Captain: ${proj.captainName} (${name})`));
        await launchOne(proj.captainName, "captain", projPath, config.defaults.permissions?.captain || "auto", false, true, name);
      }
      console.log("");
    } else if (!project) {
      // No args: interactive multi-select when TTY, error otherwise.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(
          chalk.red(
            "\n  ✘ Specify a project name, or pass --all to launch every captain.\n" +
              "    For one-shot Command tasks, use `squadrant command --task <briefing|learnings-review|wiki-aggregate>`.\n",
          ),
        );
        process.exit(1);
      }

      // Interactive: pick captains, then launch in parallel.
      ensureCmuxReady();

      const sessions = loadSessions(SESSIONS_PATH);
      const entries: CaptainEntry[] = Object.entries(config.projects).map(([name, proj]) => ({
        projectName: name,
        captainName: proj.captainName,
        lastLaunched: sessions.workspaces[proj.captainName]?.lastLaunched ?? null,
      }));

      const selected = await selectCaptainsInteractive(entries);

      if (selected.length === 0) {
        console.log(chalk.yellow("\n  No captains selected.\n"));
        return;
      }

      console.log(chalk.bold(`\nLaunching ${selected.length} captain workspace(s) in parallel\n`));

      // Discover + create spoke vaults in parallel (different directories, safe).
      await Promise.all(selected.map(async (name) => {
        const proj = config.projects[name];
        const projPath = resolveHome(proj.path);

        const spokePath = resolveHome(proj.spokeVault);
        if (!fs.existsSync(spokePath)) {
          const spokeDriver = new WorkspaceRegistry({ obsidian: createObsidianDriver }).forProject(name, config);
          await ensureSpokeLayout(spokeDriver);
          console.log(chalk.cyan(`  ✔ Created spoke vault at ${spokePath}`));
        }

        console.log(chalk.bold(`\n  Captain: ${proj.captainName} (${name})`));
        await launchOne(proj.captainName, "captain", projPath, config.defaults.permissions?.captain || "auto", false, true, name);
      }));

      console.log("");
    } else {
      // Launch captain workspace for a project
      if (!config.projects[project]) {
        console.error(
          chalk.red(
            `\n  ✘ Project '${project}' not found. Run 'squadrant projects list' to see registered projects.\n`,
          ),
        );
        process.exit(1);
      }

      const proj = config.projects[project];
      const projPath = resolveHome(proj.path);

      // Ensure spoke vault exists
      const spokePath = resolveHome(proj.spokeVault);
      if (!fs.existsSync(spokePath)) {
        const spokeDriver = new WorkspaceRegistry({ obsidian: createObsidianDriver }).forProject(project, config);
        await ensureSpokeLayout(spokeDriver);
        console.log(chalk.cyan(`  ✔ Created spoke vault at ${spokePath}`));
      }

      console.log(
        chalk.bold(
          `\nLaunching captain workspace for '${project}' (${proj.captainName})\n`,
        ),
      );
      await launchOne(proj.captainName, "captain", projPath, config.defaults.permissions?.captain || "auto", false, true, project);
    }
  });
