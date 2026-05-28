import { Command } from "commander";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import { createObsidianDriver, WorkspaceRegistry } from "../workspaces/index.js";
import { createCmuxNotifier, NotifierRegistry } from "../notifiers/index.js";
import {
  createCursorEmitter,
  createCodexEmitter,
  createGeminiEmitter,
  createOpencodeEmitter,
  ProjectionRegistry,
} from "../projection/index.js";

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function claudeVersionOk(): boolean {
  try {
    const version = execSync("claude --version", { encoding: "utf-8" }).trim();
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return false;
    const [, major, minor, patch] = match.map(Number);
    return (
      major > 2 ||
      (major === 2 && minor > 1) ||
      (major === 2 && minor === 1 && patch >= 32)
    );
  } catch {
    return false;
  }
}

function settingsHaveAgentTeams(): boolean {
  try {
    const home = process.env.HOME || "";
    const settings = JSON.parse(
      fs.readFileSync(`${home}/.claude/settings.json`, "utf-8"),
    );
    return settings?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1";
  } catch {
    return false;
  }
}

function pluginInstalled(pluginKey: string): boolean {
  try {
    const home = process.env.HOME || "";
    const plugins = JSON.parse(
      fs.readFileSync(
        `${home}/.claude/plugins/installed_plugins.json`,
        "utf-8",
      ),
    );
    return pluginKey in (plugins?.plugins || {});
  } catch {
    return false;
  }
}

function nodeVersionOk(): boolean {
  const version = process.versions.node;
  const major = parseInt(version.split(".")[0], 10);
  return major >= 18;
}

function check(label: string, pass: boolean): boolean {
  const icon = pass ? chalk.green("✔ PASS") : chalk.red("✘ FAIL");
  console.log(`  ${icon}  ${label}`);
  return pass;
}

export const doctorCommand = new Command("doctor")
  .description("Check system health and prerequisites")
  .action(async () => {
    console.log(chalk.bold("\nCockpit Doctor\n"));

    const results: boolean[] = [];

    results.push(check("Claude Code installed", commandExists("claude")));
    results.push(check("Claude Code version >= 2.1.32", claudeVersionOk()));
    results.push(check("Obsidian installed", commandExists("obsidian") || fs.existsSync("/Applications/Obsidian.app")));
    results.push(check("Node.js >= 18", nodeVersionOk()));
    results.push(
      check(
        "Agent Teams enabled (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)",
        settingsHaveAgentTeams(),
      ),
    );
    results.push(check("Plugin: superpowers", pluginInstalled("superpowers@claude-plugins-official")));
    results.push(
      check("Plugin: claude-mem", pluginInstalled("claude-mem@thedotmack")),
    );
    results.push(check("Plugin: context7", pluginInstalled("context7@claude-plugins-official")));

    const config = loadConfig();

    const runtimes = new RuntimeRegistry({ cmux: createCmuxDriver() });
    const probeResults = await runtimes.probeAll();

    // Global runtime must be installed
    const globalRuntimeName = config.runtime ?? "cmux";
    const globalProbe = probeResults[globalRuntimeName];
    results.push(check(
      `Runtime '${globalRuntimeName}' installed`,
      !!globalProbe?.installed,
    ));

    // Any project-level override must also be installed
    const overrides = new Set<string>();
    for (const proj of Object.values(config.projects)) {
      if (proj.runtime && proj.runtime !== globalRuntimeName) overrides.add(proj.runtime);
    }
    for (const runtimeName of overrides) {
      const probe = probeResults[runtimeName];
      results.push(check(
        `Runtime '${runtimeName}' installed (project override)`,
        !!probe?.installed,
      ));
    }

    // Probe workspace providers
    const workspaces = new WorkspaceRegistry({ obsidian: createObsidianDriver });
    const hubDriver = workspaces.hub(config);
    const hubProbe = await hubDriver.probe();
    results.push(check(
      `Workspace '${config.workspace ?? "obsidian"}' — hub reachable`,
      hubProbe.installed && hubProbe.rootExists,
    ));

    for (const [name] of Object.entries(config.projects)) {
      const spokeDriver = workspaces.forProject(name, config);
      const probe = await spokeDriver.probe();
      results.push(check(
        `Workspace — spoke '${name}' reachable`,
        probe.installed && probe.rootExists,
      ));
    }

    // Probe notifier providers
    const notifiers = new NotifierRegistry({ cmux: createCmuxNotifier });
    const notifierProbes = await notifiers.probeAll();
    for (const [name, probe] of Object.entries(notifierProbes)) {
      results.push(check(
        `Notifier '${name}' installed`,
        probe.installed,
      ));
      if (probe.installed) {
        results.push(check(
          `Notifier '${name}' reachable`,
          probe.reachable,
        ));
      }
    }

    // Probe projection targets
    console.log(chalk.bold("\nProjection"));
    const projectionRegistry = new ProjectionRegistry({
      cursor: createCursorEmitter,
      codex: createCodexEmitter,
      gemini: createGeminiEmitter,
      opencode: createOpencodeEmitter,
    });
    for (const name of projectionRegistry.list()) {
      const emitter = projectionRegistry.get(name);
      const [userDest] = emitter.destinations("user");
      if (!userDest) continue;
      const dir = path.dirname(userDest.path);
      let status: string;
      try {
        await stat(dir);
        status = chalk.green("✓ dir writable");
      } catch {
        status = chalk.yellow("! dir missing (will be created on emit)");
      }
      console.log(`  ${name.padEnd(10)} ${userDest.path} — ${status}`);
    }

    results.push(
      check(
        "Cockpit config exists",
        fs.existsSync(
          process.env.COCKPIT_CONFIG ||
            `${process.env.HOME}/.config/cockpit/config.json`,
        ),
      ),
    );

    const passed = results.filter(Boolean).length;
    const total = results.length;

    console.log(
      `\n${passed === total ? chalk.green("All checks passed") : chalk.yellow(`${passed}/${total} checks passed`)}\n`,
    );

    if (results.some((r) => !r)) {
      process.exit(1);
    }

    // --- Agent Probes ---
    console.log(chalk.bold("\nAgent Drivers\n"));

    const { createClaudeDriver, createCodexDriver, createGeminiDriver, createOpencodeDriver, CapabilityRegistry } = await import("../drivers/index.js");

    const agentDrivers = {
      claude: createClaudeDriver(),
      codex: createCodexDriver(),
      gemini: createGeminiDriver(),
      opencode: createOpencodeDriver(),
    };

    const registry = new CapabilityRegistry(agentDrivers);
    await registry.probeAll();

    for (const [name, driver] of Object.entries(agentDrivers)) {
      const probe = registry.getProbeResult(name);
      if (!probe || !probe.installed) {
        console.log(`  ${chalk.gray("○ SKIP")}  ${name} — not installed`);
        continue;
      }
      const caps = probe.capabilities.join(", ");
      console.log(`  ${chalk.green("✔ FOUND")} ${name} ${chalk.gray(probe.version)} — [${caps}]`);
    }

    // Show role assignments from config
    if (config.defaults.roles) {
      console.log(chalk.bold("\nRole Assignments\n"));
      for (const [role, assignment] of Object.entries(config.defaults.roles)) {
        const validation = registry.validateRole(assignment.agent, role as any);
        const statusIcon = validation.allowed ? chalk.green("✔") : chalk.red("✘");
        const warns = validation.missingPreferred.length > 0
          ? chalk.yellow(` (missing preferred: ${validation.missingPreferred.join(", ")})`)
          : "";
        console.log(`  ${statusIcon} ${role}: ${assignment.agent}${assignment.model ? ` (${assignment.model})` : ""}${warns}`);
        if (!validation.allowed && validation.reason) {
          console.log(`    ${chalk.red(validation.reason)}`);
        }
      }
    }
  });
