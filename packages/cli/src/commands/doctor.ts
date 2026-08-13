import { Command } from "commander";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { loadConfig } from "@squadrant/shared";
import { compatManifest, type ToolEntry } from "@squadrant/shared";
import { checkToolCompat } from "@squadrant/shared";
import { createCmuxDriver, RuntimeRegistry, createCmuxNotifier, NotifierRegistry, createObsidianDriver, WorkspaceRegistry } from "@squadrant/workspaces";
import { queryHealth, printServiceHealth } from "./health-view.js";
import {
  createCursorEmitter,
  createCodexEmitter,
  createGeminiEmitter,
  createOpencodeEmitter,
  ProjectionRegistry,
} from "@squadrant/agents";

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
    const [major, minor, patch] = match.slice(1).map(Number);
    const [minMajor, minMinor, minPatch] = compatManifest.tools.claude.min.split(".").map(Number);
    return (
      major > minMajor ||
      (major === minMajor && minor > minMinor) ||
      (major === minMajor && minor === minMinor && patch >= minPatch)
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
  const major = parseInt(process.versions.node.split(".")[0], 10);
  const [minMajor] = compatManifest.tools.node.min.split(".").map(Number);
  return major >= minMajor;
}

function tryGetVersion(cmd: string): string {
  try {
    return execSync(`${cmd} --version`, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

// #670-C: surface duplicate global installs (npm + pnpm + yarn each claim
// their own daemon entry, and one flip-flops the other's launchd plist).

export interface GlobalInstallCandidate {
  manager: "npm" | "pnpm" | "yarn";
  packageJsonPath: string;
}

/** Pure: turn resolved global-root paths into squadrant/package.json candidates. */
export function candidateGlobalInstalls(roots: { npm?: string; pnpm?: string; yarn?: string }): GlobalInstallCandidate[] {
  const out: GlobalInstallCandidate[] = [];
  if (roots.npm) out.push({ manager: "npm", packageJsonPath: path.join(roots.npm, "squadrant", "package.json") });
  if (roots.pnpm) out.push({ manager: "pnpm", packageJsonPath: path.join(roots.pnpm, "squadrant", "package.json") });
  if (roots.yarn) out.push({ manager: "yarn", packageJsonPath: path.join(roots.yarn, "node_modules", "squadrant", "package.json") });
  return out;
}

export interface DetectedInstall {
  manager: string;
  packageJsonPath: string;
  version: string;
}

/** Pure: keep only candidates whose package.json actually resolves a version. */
export function findInstalledSquadrants(
  candidates: GlobalInstallCandidate[],
  readVersion: (packageJsonPath: string) => string | null,
): DetectedInstall[] {
  const out: DetectedInstall[] = [];
  for (const c of candidates) {
    const version = readVersion(c.packageJsonPath);
    if (version) out.push({ manager: c.manager, packageJsonPath: c.packageJsonPath, version });
  }
  return out;
}

/** Pure: null when there's nothing to warn about (0 or 1 install found). */
export function formatDuplicateInstallWarning(installs: DetectedInstall[]): string | null {
  if (installs.length <= 1) return null;
  const lines = installs.map((i) => `    ${i.manager}: ${i.packageJsonPath} (v${i.version})`);
  return (
    `Multiple squadrant installs detected:\n${lines.join("\n")}\n` +
    "    Two installs fight over the daemon plist (#670) — uninstall the one you don't use, then run `squadrant heal daemon`."
  );
}

function readPackageVersion(packageJsonPath: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function tryGetGlobalRoot(cmd: string, args: string[]): string | undefined {
  try {
    return execSync(`${cmd} ${args.join(" ")}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Exported for unit testing. */
export function check(label: string, pass: boolean, hint?: string): boolean {
  const icon = pass ? chalk.green("✔ PASS") : chalk.red("✘ FAIL");
  console.log(`  ${icon}  ${label}`);
  if (!pass && hint) {
    console.log(`         ${chalk.cyan("→")} ${chalk.dim(hint)}`);
  }
  return pass;
}

export const doctorCommand = new Command("doctor")
  .description("Check system health and prerequisites")
  .action(async () => {
    console.log(chalk.bold("\nSquadrant Doctor\n"));

    const results: boolean[] = [];

    results.push(check("Claude Code installed", commandExists("claude"),
      "Install from: https://claude.ai/code"));
    results.push(check(`Claude Code version >= ${compatManifest.tools.claude.min}`, claudeVersionOk(),
      `Update Claude Code to >= ${compatManifest.tools.claude.min}`));
    results.push(check("Obsidian installed", commandExists("obsidian") || fs.existsSync("/Applications/Obsidian.app"),
      "Install from: https://obsidian.md"));
    results.push(check("Node.js >= 18", nodeVersionOk(),
      "Install from: https://nodejs.org"));
    results.push(
      check(
        "Agent Teams enabled (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)",
        settingsHaveAgentTeams(),
        "Run: squadrant init  (enables automatically), or add to shell profile: export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1",
      ),
    );
    results.push(check("Plugin: superpowers", pluginInstalled("superpowers@claude-plugins-official"),
      "In Claude Code, run: /plugin marketplace add superpowers"));
    results.push(
      check("Plugin: claude-mem", pluginInstalled("claude-mem@thedotmack"),
        "In Claude Code, run: /plugin marketplace add thedotmack/claude-mem"),
    );
    results.push(check("Plugin: context7", pluginInstalled("context7@claude-plugins-official"),
      "In Claude Code, run: /plugin marketplace add context7"));

    const config = loadConfig();

    const runtimes = new RuntimeRegistry({ cmux: createCmuxDriver() });
    const probeResults = await runtimes.probeAll();

    // Global runtime must be installed
    const globalRuntimeName = config.runtime ?? "cmux";
    const globalProbe = probeResults[globalRuntimeName];
    results.push(check(
      `Runtime '${globalRuntimeName}' installed`,
      !!globalProbe?.installed,
      globalRuntimeName === "cmux"
        ? "Install: npm install -g cmux  or download from https://cmux.dev"
        : undefined,
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
      "Run: squadrant init  to scaffold the hub vault",
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
        "Squadrant config exists",
        fs.existsSync(
          process.env.SQUADRANT_CONFIG ||
            `${process.env.HOME}/.config/squadrant/config.json`,
        ),
        "Run: squadrant init",
      ),
    );

    const passed = results.filter(Boolean).length;
    const total = results.length;

    console.log(
      `\n${passed === total ? chalk.green("All checks passed") : chalk.yellow(`${passed}/${total} checks passed`)}\n`,
    );

    // #670-C: warn (non-blocking) when more than one global install is found —
    // whichever one runs a captain command will keep flip-flopping the other's
    // launchd plist registration.
    const installCandidates = candidateGlobalInstalls({
      npm: tryGetGlobalRoot("npm", ["root", "-g"]),
      pnpm: tryGetGlobalRoot("pnpm", ["root", "-g"]),
      yarn: tryGetGlobalRoot("yarn", ["global", "dir"]),
    });
    const duplicateWarning = formatDuplicateInstallWarning(findInstalledSquadrants(installCandidates, readPackageVersion));
    if (duplicateWarning) {
      console.log(`\n${chalk.yellow("⚠ WARN")}  ${duplicateWarning}`);
    }

    // #77 service-health: live per-component liveness from the daemon. Printed
    // before the prereq-fail exit so a degraded install still shows what is up.
    printServiceHealth(await queryHealth());

    // Non-blocking version compat drift for every tool in the manifest.
    // Tools not installed are skipped silently; only drift (below min / above
    // lastVerified) produces a warning line — nothing here causes an exit.
    console.log(chalk.bold("\nTool Version Compat\n"));
    const toolVersionMap: Record<string, string> = {
      cmux:     probeResults["cmux"]?.version ?? "",
      claude:   tryGetVersion("claude"),
      node:     process.versions.node,
      codex:    tryGetVersion("codex"),
      gemini:   tryGetVersion("gemini"),
      opencode: tryGetVersion("opencode"),
    };
    for (const [name, entry] of Object.entries(compatManifest.tools) as [string, ToolEntry][]) {
      const version = toolVersionMap[name] ?? "";
      if (!version) continue;
      const warn = checkToolCompat(name, version, entry);
      if (warn) {
        console.log(`  ${chalk.yellow("⚠ WARN")}  ${name}: ${warn}`);
      } else {
        console.log(`  ${chalk.green("✔ OK  ")}  ${name}: ${version}`);
      }
    }

    if (results.some((r) => !r)) {
      process.exit(1);
    }

    // --- Agent Probes ---
    console.log(chalk.bold("\nAgent Drivers\n"));

    const { createClaudeDriver, createCodexDriver, createGeminiDriver, createOpencodeDriver, CapabilityRegistry } = await import("@squadrant/agents");

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
