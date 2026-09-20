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
  isProviderPresetId,
  detectProviderPresetId,
  applyProviderPreset,
  PROVIDER_PRESETS,
  DEFAULT_ROUTER_KIND,
  DEFAULT_ROUTER_BASE_URL,
  isRouterKind,
  type ProviderPresetId,
  type RouterConfig,
  type SquadrantConfig,
} from "@squadrant/shared";
import { createObsidianDriver, WorkspaceRegistry } from "@squadrant/workspaces";
import { ensureRuntimeSynced } from "@squadrant/shared";
import { ensureGlobalOpencodeConfig, DEFAULT_GLOBAL_OPENCODE_CONFIG_PATH } from "../lib/per-crew-settings.js";
import { detectClaudeAuth, type ClaudeAuthStatus } from "../lib/claude-auth.js";
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

interface InitOptions {
  hub: string;
  preset?: string;
  routerKind?: string;
  routerBaseUrl?: string;
  routerApiKeyEnv?: string;
}

/** #826: resolve the router block for preset C: reuse an existing block, else
 *  take --router-* flags, else prompt (TTY), else fall back to the documented
 *  opencode-go upstream. Never returns undefined — preset C always writes a router. */
async function resolveRouter(
  config: SquadrantConfig,
  opts: InitOptions,
  isTTY: boolean,
): Promise<RouterConfig> {
  if (config.defaults?.router) return config.defaults.router;

  let kind = opts.routerKind;
  let baseUrl = opts.routerBaseUrl;
  let apiKeyEnv = opts.routerApiKeyEnv;

  if (isTTY && (!kind || !baseUrl)) {
    const k = await promptLine(chalk.cyan(`    Router kind [${DEFAULT_ROUTER_KIND}]: `));
    kind = kind ?? (k || DEFAULT_ROUTER_KIND);
    const b = await promptLine(chalk.cyan(`    Router base URL [${DEFAULT_ROUTER_BASE_URL}]: `));
    baseUrl = baseUrl ?? (b || DEFAULT_ROUTER_BASE_URL);
    const e = await promptLine(chalk.cyan("    Env var holding the API key (optional): "));
    apiKeyEnv = apiKeyEnv ?? (e || undefined);
  }

  const resolvedKind = kind && isRouterKind(kind) ? kind : DEFAULT_ROUTER_KIND;
  const resolvedBase = baseUrl || DEFAULT_ROUTER_BASE_URL;
  if (!isTTY && !opts.routerBaseUrl) {
    console.log(chalk.dim(`    - no router flags given; defaulting to ${resolvedKind} (${resolvedBase})`));
    console.log(chalk.dim("      set a credential: squadrant config set defaults.router.apiKeyEnv <VAR>"));
  }
  return { kind: resolvedKind, baseUrl: resolvedBase, ...(apiKeyEnv ? { apiKeyEnv } : {}) };
}

/** One provider question (#826). Returns the operator's preset choice. */
async function askProvider(
  current: ProviderPresetId,
  auth: ClaudeAuthStatus,
): Promise<ProviderPresetId> {
  console.log(chalk.bold("\n    Choose your provider:"));
  for (const p of PROVIDER_PRESETS) {
    const currentTag = p.id === current ? chalk.dim(" (current)") : "";
    console.log(`      ${chalk.cyan(`${p.id})`)} ${p.label}${currentTag}`);
    console.log(chalk.dim(`         ${p.summary}`));
  }
  if (!auth.authenticated) {
    console.log(chalk.yellow("\n    ⚠ No Anthropic credential detected — preset a will not work; consider b or c."));
  }
  const answer = (await promptLine(chalk.cyan(`\n    Provider [a/b/c/d] (default ${current}): `))).toLowerCase();
  if (!answer) return current;
  if (isProviderPresetId(answer)) return answer;
  console.log(chalk.yellow(`    ⚠ Unknown choice '${answer}' — keeping '${current}'.`));
  return current;
}

/** Warn (never block) when preset A is chosen without a detectable Anthropic credential. */
function warnIfNoAnthropic(preset: ProviderPresetId, auth: ClaudeAuthStatus): void {
  if (preset !== "a" || auth.authenticated) return;
  console.log(chalk.yellow("    ⚠ No Anthropic credential detected (`claude auth status`)."));
  console.log(chalk.dim("      Preset A (Claude Pro/Max or an API key) may not work — consider preset b or c."));
}

export const initCommand = new Command("init")
  .description("Guided first-time setup: provider, hub vault, agents, plugins, projects (re-run-safe)")
  .option("--hub <path>", "Hub vault path", "~/squadrant-hub")
  .option("--preset <id>", "provider preset: a|b|c|d (non-interactive)")
  .option("--router-kind <kind>", "router kind for --preset c (opencode-go|openrouter|ccr|litellm|custom)")
  .option("--router-base-url <url>", "router base URL for --preset c")
  .option("--router-api-key-env <env>", "env var holding the router credential for --preset c")
  .action(async (opts: InitOptions) => {
    const hubPath = resolveHome(opts.hub);
    const pkgRoot = findPackageRoot();
    const configDir = path.join(os.homedir(), ".config", "squadrant");
    const isTTY = process.stdin.isTTY === true;

    console.log(chalk.bold("\nSquadrant Init\n"));

    // Validate an explicit --preset before doing anything.
    let explicitPreset: ProviderPresetId | undefined;
    if (opts.preset !== undefined) {
      const candidate = opts.preset.toLowerCase();
      if (!isProviderPresetId(candidate)) {
        console.error(chalk.red(`  ✘ Unknown --preset '${opts.preset}'. Valid values: a, b, c, d`));
        process.exitCode = 1;
        return;
      }
      explicitPreset = candidate;
    }

    // Non-TTY without --preset: print step checklist + next-commands and exit without blocking
    if (!isTTY && !explicitPreset) {
      console.log("  Run these steps to get started:\n");
      console.log(chalk.bold("  1/5  Hub vault + provider"));
      console.log(chalk.cyan(`       squadrant init --hub ${opts.hub}`));
      console.log(chalk.dim("       Choose a provider: squadrant init --preset a|b|c|d"));
      console.log(chalk.bold("\n  2/5  Agent + projection setup"));
      console.log("       (handled automatically by: " + chalk.cyan("squadrant init") + ")");
      console.log(chalk.bold("\n  3/5  Plugins — open Claude Code and run:"));
      console.log(chalk.cyan("       /plugin marketplace add superpowers"));
      console.log(chalk.cyan("       /plugin marketplace add thedotmack/claude-mem"));
      console.log(chalk.cyan("       /plugin marketplace add context7"));
      console.log(chalk.dim("\n       Using opencode crews? Install the CLI:"));
      console.log(chalk.cyan("       npm install -g opencode-ai"));
      console.log(chalk.dim(`       (squadrant provisions a default model in ${DEFAULT_GLOBAL_OPENCODE_CONFIG_PATH} if it's missing)`));
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

    // ── 1/5  Hub vault + provider preset (#826) ─────────────────────────────
    stepHeader(1, 5, "Hub vault");

    const configExists = fs.existsSync(DEFAULT_CONFIG_PATH);
    let config: SquadrantConfig;
    if (configExists) {
      console.log(chalk.yellow("    ⚠ Config already exists, skipping creation"));
      config = loadConfig();
    } else {
      config = getDefaultConfig();
      config.hubVault = hubPath;
    }

    // Ask ONE provider question (interactive), or apply --preset non-interactively.
    const auth = detectClaudeAuth();
    let chosenPreset: ProviderPresetId | undefined = explicitPreset;
    if (!chosenPreset && isTTY) {
      chosenPreset = await askProvider(detectProviderPresetId(config), auth);
    }

    let appliedChanges: string[] = [];
    if (chosenPreset) {
      const label = PROVIDER_PRESETS.find((p) => p.id === chosenPreset)?.label ?? chosenPreset;
      const router = chosenPreset === "c" ? await resolveRouter(config, opts, isTTY) : undefined;
      const overwrite = !configExists || explicitPreset !== undefined;
      const result = applyProviderPreset(config, chosenPreset, { router, overwrite });
      appliedChanges = result.changes;
      config = result.config;

      console.log(chalk.bold(`\n    Provider: ${chosenPreset.toUpperCase()} — ${label}`));
      if (appliedChanges.length) {
        console.log("    Will change:");
        for (const change of appliedChanges) console.log(chalk.dim(`      - ${change}`));
      } else {
        console.log(chalk.dim("    - provider config already set (unchanged)"));
      }
      // Interactive already showed the hint above the question; only the
      // non-interactive path needs the standalone warning.
      if (!isTTY) warnIfNoAnthropic(chosenPreset, auth);
    }

    if (!configExists) {
      saveConfig(config);
      console.log(chalk.green(`    ✔ Config created at ${DEFAULT_CONFIG_PATH}`));
    } else if (appliedChanges.length) {
      saveConfig(config);
      console.log(chalk.green(`    ✔ Config updated at ${DEFAULT_CONFIG_PATH}`));
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

    console.log(chalk.bold("\n    Using opencode crews?"));
    console.log(chalk.cyan("      npm install -g opencode-ai"));
    const opencodeConfigWritten = ensureGlobalOpencodeConfig();
    if (opencodeConfigWritten) {
      console.log(chalk.green(`    ✔ Default model config created at ${opencodeConfigWritten}`));
    } else {
      console.log(chalk.dim(`    - ${DEFAULT_GLOBAL_OPENCODE_CONFIG_PATH} already exists (unchanged)`));
    }
    console.log(chalk.dim("    Per-crew config deep-merges with this file — edit it to change opencode's default model/plugins/mcp."));

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
