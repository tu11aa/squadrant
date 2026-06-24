import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execSync } from "node:child_process";
import chalk from "chalk";
import {
  getDefaultConfig,
  saveConfig,
  DEFAULT_CONFIG_PATH,
  resolveHome,
  readUserLevelSource,
  loadConfig,
} from "@squadrant/shared";
import { createObsidianDriver, WorkspaceRegistry } from "@squadrant/workspaces";
import { ensureRuntimeSynced } from "@squadrant/shared";
import {
  createCursorEmitter,
  createCodexEmitter,
  createGeminiEmitter,
  createOpencodeEmitter,
  ProjectionRegistry,
} from "@squadrant/agents";

function findPackageRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (dir !== "/") {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function stepHeader(n: number, total: number, label: string): void {
  console.log(chalk.bold(`\n  ${n}/${total}  ${label}`));
}

function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export const initCommand = new Command("init")
  .description("Guided first-time setup: hub vault, agents, plugins, projects (re-run-safe)")
  .option("--hub <path>", "Hub vault path", "~/squadrant-hub")
  .action(async (opts: { hub: string }) => {
    const hubPath = resolveHome(opts.hub);
    const pkgRoot = findPackageRoot();
    const configDir = path.join(os.homedir(), ".config", "squadrant");
    const isTTY = process.stdin.isTTY === true;

    console.log(chalk.bold("\nSquadrant Init\n"));

    // Non-TTY: print step checklist + next-commands and exit without blocking
    if (!isTTY) {
      console.log("  Run these steps to get started:\n");
      console.log(chalk.bold("  1/5  Hub vault"));
      console.log(chalk.cyan(`       squadrant init --hub ${opts.hub}`));
      console.log(chalk.bold("\n  2/5  Agent + projection setup"));
      console.log("       (handled automatically by: " + chalk.cyan("squadrant init") + ")");
      console.log(chalk.bold("\n  3/5  Plugins — open Claude Code and run:"));
      console.log(chalk.cyan("       /plugin marketplace add superpowers"));
      console.log(chalk.cyan("       /plugin marketplace add thedotmack/claude-mem"));
      console.log(chalk.cyan("       /plugin marketplace add context7"));
      console.log(chalk.bold("\n  4/5  Register first project"));
      console.log(chalk.cyan("       squadrant projects add <name> <path>"));
      console.log(chalk.bold("\n  5/5  Telegram (optional)"));
      console.log(chalk.cyan("       squadrant telegram setup"));
      console.log(chalk.bold("\n  Then:"));
      console.log(chalk.cyan("       squadrant launch <projectname>\n"));
      return;
    }

    // Verify the default workspace provider is registered
    const wsRegistry = new WorkspaceRegistry({ obsidian: createObsidianDriver });
    try {
      if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
        const existing = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf-8"));
        wsRegistry.get(existing.workspace ?? "obsidian");
      }
    } catch (err) {
      console.log(chalk.red(`  ✘ ${(err as Error).message}`));
      return;
    }

    // ── 1/5  Hub vault ──────────────────────────────────────────────────────
    stepHeader(1, 5, "Hub vault");

    if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
      console.log(chalk.yellow("    ⚠ Config already exists, skipping creation"));
    } else {
      const config = getDefaultConfig();
      config.hubVault = hubPath;
      saveConfig(config);
      console.log(chalk.green(`    ✔ Config created at ${DEFAULT_CONFIG_PATH}`));
    }

    const hubTemplate = path.join(pkgRoot, "obsidian", "hub");
    if (fs.existsSync(hubPath)) {
      console.log(chalk.yellow(`    ⚠ Hub vault already exists at ${hubPath}`));
    } else if (fs.existsSync(hubTemplate)) {
      copyDirRecursive(hubTemplate, hubPath);
      console.log(chalk.green(`    ✔ Hub vault scaffolded at ${hubPath}`));
    } else {
      fs.mkdirSync(hubPath, { recursive: true });
      console.log(chalk.yellow(`    ⚠ Hub template not found; created empty directory at ${hubPath}`));
    }

    // Refresh dashboard.md and ensure projects/ dir exist (idempotent — #44)
    const hubDashboardSrc = path.join(pkgRoot, "obsidian", "hub", "dashboard.md");
    const hubDashboardDest = path.join(hubPath, "dashboard.md");
    if (fs.existsSync(hubDashboardSrc)) {
      fs.copyFileSync(hubDashboardSrc, hubDashboardDest);
      console.log(chalk.green(`    ✔ Dashboard refreshed`));
    }
    fs.mkdirSync(path.join(hubPath, "projects"), { recursive: true });

    ensureRuntimeSynced({ sourceRoot: pkgRoot, runtimeRoot: configDir });
    console.log(chalk.green(`    ✔ Runtime assets synced to ${configDir}`));

    // ── 2/5  Agent + projection setup ───────────────────────────────────────
    stepHeader(2, 5, "Agent + projection setup");

    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    try {
      let settings: Record<string, unknown> = {};
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      }
      const env = (settings.env as Record<string, string>) || {};
      if (env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS !== "1") {
        settings.env = { ...env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" };
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
        console.log(chalk.green("    ✔ Agent Teams enabled in ~/.claude/settings.json"));
      } else {
        console.log(chalk.green("    ✔ Agent Teams already enabled"));
      }
    } catch {
      console.log(chalk.yellow("    ⚠ Could not update ~/.claude/settings.json"));
      console.log(chalk.dim("      Add manually to shell profile: export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"));
    }

    // Emit projection files so non-Claude agents (codex, gemini, opencode, cursor)
    // each get their AGENTS.md / GEMINI.md with up-to-date instructions.
    try {
      const projRegistry = new ProjectionRegistry({
        cursor: createCursorEmitter,
        codex: createCodexEmitter,
        gemini: createGeminiEmitter,
        opencode: createOpencodeEmitter,
      });
      const workspace = createObsidianDriver({ root: process.cwd() });
      const source = await readUserLevelSource(workspace, { pkgRoot });
      for (const name of projRegistry.list()) {
        const emitter = projRegistry.get(name);
        for (const dest of emitter.destinations("user")) {
          const result = await emitter.emit(source, dest);
          if (result.written) {
            console.log(chalk.green(`    ✔ ${name} → ${dest.path}`));
          } else {
            console.log(chalk.dim(`    - ${name} → ${dest.path} (unchanged)`));
          }
        }
      }
    } catch (err) {
      console.log(chalk.yellow(`    ⚠ Projection emit skipped: ${(err as Error).message}`));
    }

    // ── 3/5  Plugins ────────────────────────────────────────────────────────
    stepHeader(3, 5, "Plugins");
    console.log("    Install these plugins inside Claude Code:\n");
    console.log(chalk.cyan("      /plugin marketplace add superpowers"));
    console.log(chalk.cyan("      /plugin marketplace add thedotmack/claude-mem"));
    console.log(chalk.cyan("      /plugin marketplace add context7\n"));
    console.log(chalk.dim("    Squadrant never auto-installs plugins — open Claude Code and run the commands above."));

    // ── 4/5  Register first project ─────────────────────────────────────────
    stepHeader(4, 5, "Register first project");

    const projectPath = await promptLine(
      chalk.cyan("    Absolute path to your first project (Enter to skip): "),
    );
    if (projectPath) {
      const projectName = path.basename(projectPath);
      console.log(chalk.bold(`\n    Run this to register it:`));
      console.log(chalk.cyan(`      squadrant projects add ${projectName} ${projectPath}\n`));
    } else {
      console.log(chalk.dim("    Skipped. Register later with:"));
      console.log(chalk.cyan("      squadrant projects add <name> <path>"));
    }

    // ── 5/5  Telegram ───────────────────────────────────────────────────────
    stepHeader(5, 5, "Telegram (optional)");
    console.log("    Get notified on your phone when crews complete tasks:");
    console.log(chalk.cyan("      squadrant telegram setup\n"));

    // ── Final summary ────────────────────────────────────────────────────────
    let launchTarget = "<projectname>";
    try {
      const cfg = loadConfig();
      const first = Object.keys(cfg.projects)[0];
      if (first) launchTarget = first;
    } catch { /* config may not exist if init just created it */ }

    console.log(chalk.bold.green("\n  ✔ You are ready!\n"));
    console.log(`     Run: ${chalk.cyan(`squadrant launch ${launchTarget}`)}\n`);
  });
