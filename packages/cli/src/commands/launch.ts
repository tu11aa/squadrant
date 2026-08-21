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
import { loadConfig, resolveHome, ensureSpokeLayout, resolveCaptainChannelMode } from "@squadrant/shared";
import type { ModelRoutingConfig } from "@squadrant/shared";
import {
  createClaudeDriver, createCodexDriver, createGeminiDriver, createOpencodeDriver,
  CapabilityRegistry, buildAgentCmd,
} from "@squadrant/agents";
import {
  RuntimeRegistry, createCmuxDriver, createObsidianDriver, WorkspaceRegistry,
  isInsideCmux, cmuxLocal, classifyStartupSurface,
} from "@squadrant/workspaces";
import { launchOneWorkspace, loadSessions, CC_SOCKS_DIR } from "@squadrant/core";
import { selectCaptainsInteractive } from "./launch-interactive.js";
import type { CaptainEntry } from "./launch-interactive.js";
import { resolveLaunchAgent } from "../lib/launch-agent-resolve.js";
import { isBlockedFallback, anthropicRefusalMessage } from "../lib/model-guard.js";
import { readGlobalOpencodeModel } from "../lib/per-crew-settings.js";

// Re-export for test-import stability (launch.test.ts imports from ../launch.js).
export { deliverStartupPrompt } from "@squadrant/core";
export type { StartupDeliveryOptions } from "@squadrant/core";

const CMUX_APP = "/Applications/cmux.app";
const TEMPLATES_DIR = path.join(os.homedir(), ".config", "squadrant", "templates");
const SESSIONS_PATH = path.join(os.homedir(), ".config", "squadrant", "sessions.json");

// #697: an off-by-default feature must not alter the launch command or touch
// the filesystem. Only wire the captain messaging socket when captain
// delivery is actually enabled (shadow/on), not merely agentName==="claude".
// Exported for testing (see launch.test.ts).
export function shouldWireCaptainChannel(
  agentName: string,
  config: { defaults: Parameters<typeof resolveCaptainChannelMode>[0] },
): boolean {
  return agentName === "claude" && resolveCaptainChannelMode(config.defaults) !== "off";
}

// #706: the socket path must be built from launchOne's `projectName` param,
// not the command's `project` positional — `project` is undefined on the
// --all and interactive-parallel paths, which collapsed every captain onto
// the same /tmp/cc-socks/squadrant-captain-undefined.sock (first bind wins).
// Exported for testing (see launch.test.ts).
export function captainSocketPath(projectName: string): string {
  return path.join(CC_SOCKS_DIR, `squadrant-captain-${projectName}.sock`);
}

// #627 item B, review follow-up: the guard itself (isBlockedFallback) takes no
// role argument, so it cannot special-case by role — it refuses for whatever
// role launchOne is called with. Today that's only "captain": launch.ts's three
// launchOne call sites all pass role="captain" literally, and `squadrant
// command` / `squadrant side spawn` boot agents through their own code paths
// (command.ts, side.ts) that never call launchOne or this guard at all. If
// launchOne is ever reused for those roles, the refusal applies unchanged —
// that's deliberate, not an oversight. Exported so launch.test.ts can pin
// role-agnosticism directly, instead of only the message text.
export function resolveAnthropicRefusal(
  role: string,
  workspaceName: string,
  agentName: string,
  model: string | undefined,
  readOpencodeModel: () => string | undefined = readGlobalOpencodeModel,
): string | null {
  const effectiveModel = model ?? (agentName === "opencode" ? readOpencodeModel() : undefined);
  if (!isBlockedFallback(agentName, effectiveModel)) return null;
  return anthropicRefusalMessage(role, workspaceName, agentName, effectiveModel!);
}

// #520: a non-interactive caller (the daemon's Telegram boot-if-down path)
// has no CMUX_WORKSPACE_ID and no terminal to run `open` from — headless=true
// bypasses the isInsideCmux() gate entirely so launchOneWorkspace can drive
// runtime.spawn directly, the same way crew-spawn already does from the daemon.
export function ensureCmuxReady(headless: boolean): void {
  if (headless || isInsideCmux()) return;

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
  .option("--keep", "Resume the latest session even on a new day / after a template change")
  .option("--all", "Launch all captain workspaces")
  .option("--headless", "Skip the interactive cmux-app requirement (used by the daemon to boot captains without a terminal)")
  .option("--agent <name>", "Override captain agent for this launch (claude|codex|gemini|opencode); takes precedence over defaults.roles.captain.agent")
  .option("--model <name>", "Override captain model for this launch; takes precedence over defaults.roles.captain.model")
  .action(async (project: string | undefined, opts: { fresh?: boolean; keep?: boolean; all?: boolean; headless?: boolean; agent?: string; model?: string }) => {
    if (opts.fresh && opts.keep) {
      console.error(chalk.red("\n  ✘ --fresh and --keep are mutually exclusive\n"));
      process.exit(1);
    }

    const config = loadConfig();
    let hadFailure = false;

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
      const roleConfig = config.defaults.roles?.[role as keyof NonNullable<typeof config.defaults.roles>];
      const { agentName, model } = resolveLaunchAgent(
        { agent: opts.agent, model: opts.model },
        roleConfig,
        config.defaults.models?.[role as keyof ModelRoutingConfig],
      );

      // #627 item B: refuse to boot a fallback agent that silently depends on
      // the provider it's meant to survive losing. For opencode, an omitted
      // --model doesn't mean "no model" — it falls through to opencode's own
      // global config, which defaults to an Anthropic model (ensureGlobalOpencodeConfig).
      // Refuse (not warn): the whole point of manual mode is surviving an
      // Anthropic outage, so a silent Anthropic dependency here is the exact
      // trap this command exists to close. See resolveAnthropicRefusal for why
      // this applies to whatever role launchOne is called with, not just captain.
      const refusal = resolveAnthropicRefusal(role, workspaceName, agentName, model);
      if (refusal) {
        console.error(chalk.red(`\n  ✘ ${refusal}\n`));
        hadFailure = true;
        return;
      }

      ensureCmuxReady(!!opts.headless);

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
          keepOverride: opts.keep,
          sessionsPath: SESSIONS_PATH,
          templatesDir: TEMPLATES_DIR,
          agentCmdFactory: (forceFresh) => {
            const captainChannelEnabled = shouldWireCaptainChannel(agentName, config);
            if (captainChannelEnabled) {
              fs.mkdirSync(CC_SOCKS_DIR, { recursive: true });
            }
            return buildAgentCmd(agentName, registry, role, forceFresh, permissionMode, model, TEMPLATES_DIR,
              captainChannelEnabled && projectName ? captainSocketPath(projectName) : undefined);
          },
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
        hadFailure = true;
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
      ensureCmuxReady(!!opts.headless);

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

    // #520: surface a real launch failure (e.g. cmux spawn error) as a non-zero
    // exit so the daemon's execFile-based caller can tell launch didn't work,
    // instead of silently exiting 0 while ensureCaptainAlive polls to a timeout.
    if (hadFailure) process.exitCode = 1;
  });
