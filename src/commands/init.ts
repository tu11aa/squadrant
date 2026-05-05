import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import chalk from "chalk";
import {
  getDefaultConfig,
  saveConfig,
  DEFAULT_CONFIG_PATH,
  resolveHome,
} from "../config.js";
import { createObsidianDriver, WorkspaceRegistry } from "../workspaces/index.js";

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

export const initCommand = new Command("init")
  .description("First-time setup: scaffold hub vault, scripts, and config")
  .option("--hub <path>", "Hub vault path", "~/cockpit-hub")
  .action((opts: { hub: string }) => {
    const hubPath = resolveHome(opts.hub);
    const pkgRoot = findPackageRoot();
    const configDir = path.join(os.homedir(), ".config", "cockpit");

    console.log(chalk.bold("\nCockpit Init\n"));

    // Verify the default workspace provider is registered (cockpit ships obsidian;
    // if user already has a config pointing to an unknown provider, bail early)
    const registry = new WorkspaceRegistry({ obsidian: createObsidianDriver });
    try {
      if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
        const existing = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf-8"));
        const wsName = existing.workspace ?? "obsidian";
        registry.get(wsName);
      }
    } catch (err) {
      console.log(chalk.red(`  ✘ ${(err as Error).message}`));
      return;
    }

    // 1. Create config
    if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
      console.log(chalk.yellow("  ⚠ Config already exists, skipping creation"));
    } else {
      const config = getDefaultConfig();
      config.hubVault = hubPath;
      saveConfig(config);
      console.log(chalk.green(`  ✔ Config created at ${DEFAULT_CONFIG_PATH}`));
    }

    // 2. Scaffold hub vault from template
    const hubTemplate = path.join(pkgRoot, "obsidian", "hub");
    if (fs.existsSync(hubPath)) {
      console.log(chalk.yellow(`  ⚠ Hub vault already exists at ${hubPath}, skipping`));
    } else if (fs.existsSync(hubTemplate)) {
      copyDirRecursive(hubTemplate, hubPath);
      console.log(chalk.green(`  ✔ Hub vault scaffolded at ${hubPath}`));
    } else {
      fs.mkdirSync(hubPath, { recursive: true });
      console.log(chalk.yellow(`  ⚠ Hub template not found; created empty dir at ${hubPath}`));
    }

    // 2b. Always refresh dashboard.md and ensure projects/ exists (idempotent — see #44)
    const hubDashboardSrc = path.join(pkgRoot, "obsidian", "hub", "dashboard.md");
    const hubDashboardDest = path.join(hubPath, "dashboard.md");
    if (fs.existsSync(hubDashboardSrc)) {
      fs.copyFileSync(hubDashboardSrc, hubDashboardDest);
      console.log(chalk.green(`  ✔ Dashboard page refreshed at ${hubDashboardDest}`));
    }
    const projectsDir = path.join(hubPath, "projects");
    fs.mkdirSync(projectsDir, { recursive: true });

    // 3. Copy scripts to ~/.config/cockpit/scripts/ and make executable
    const scriptsTemplate = path.join(pkgRoot, "scripts");
    const scriptsTarget = path.join(configDir, "scripts");
    if (fs.existsSync(scriptsTemplate)) {
      fs.mkdirSync(scriptsTarget, { recursive: true });
      for (const file of fs.readdirSync(scriptsTemplate)) {
        if (file.endsWith(".sh")) {
          const src = path.join(scriptsTemplate, file);
          const dest = path.join(scriptsTarget, file);
          fs.copyFileSync(src, dest);
          fs.chmodSync(dest, 0o755);
        }
      }
      console.log(chalk.green(`  ✔ Scripts copied to ${scriptsTarget}`));
    } else {
      console.log(chalk.yellow("  ⚠ Scripts directory not found in package"));
    }

    // 4. Copy CLAUDE.md role templates to ~/.config/cockpit/templates/
    const orchestratorDir = path.join(pkgRoot, "orchestrator");
    const templatesTarget = path.join(configDir, "templates");
    if (fs.existsSync(orchestratorDir)) {
      fs.mkdirSync(templatesTarget, { recursive: true });
      for (const file of fs.readdirSync(orchestratorDir)) {
        if (file.endsWith(".claude.md") || file.endsWith(".generic.md") || file.endsWith(".CLAUDE.md")) {
          const src = path.join(orchestratorDir, file);
          const dest = path.join(templatesTarget, file);
          fs.copyFileSync(src, dest);
        }
      }
      console.log(chalk.green(`  ✔ Role templates copied to ${templatesTarget}`));
    } else {
      console.log(chalk.yellow("  ⚠ Orchestrator templates not found in package"));
    }

    // 5. Copy cockpit plugin (skills) to ~/.config/cockpit/plugin/
    const pluginSrc = path.join(pkgRoot, "plugin");
    const pluginTarget = path.join(configDir, "plugin");
    if (fs.existsSync(pluginSrc)) {
      copyDirRecursive(pluginSrc, pluginTarget);
      console.log(chalk.green(`  ✔ Cockpit plugin (skills) copied to ${pluginTarget}`));
    } else {
      console.log(chalk.yellow("  ⚠ Plugin directory not found in package"));
    }

    // 6. Enable Agent Teams in settings.json if not set
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
        console.log(chalk.green("  ✔ Agent Teams enabled in ~/.claude/settings.json"));
      } else {
        console.log(chalk.green("  ✔ Agent Teams already enabled"));
      }
    } catch {
      console.log(chalk.yellow("  ⚠ Could not update ~/.claude/settings.json"));
    }

    // 5. Print manual steps
    console.log(chalk.bold("\nManual steps required:\n"));
    console.log("  1. Install plugins in Claude Code:");
    console.log(chalk.cyan("       /plugin marketplace add thedotmack/claude-mem"));
    console.log(chalk.cyan("       /plugin install claude-mem"));
    console.log("       Install context7 and superpowers from /plugin marketplace");
    console.log("");
    console.log("  2. Install cmux if not already installed:");
    console.log(chalk.cyan("       npm install -g cmux"));
    console.log("");
    console.log("  3. Open Obsidian and add the hub vault:");
    console.log(chalk.cyan(`       ${hubPath}`));
    console.log("");
    console.log("  4. Run " + chalk.cyan("cockpit doctor") + " to verify setup\n");

    if (!fs.existsSync("/Applications/cmux.app")) {
      console.log(chalk.yellow("  ⚠ cmux not found — download from https://cmux.dev\n"));
    }
  });
