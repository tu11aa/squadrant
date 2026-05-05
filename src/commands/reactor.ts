import { Command } from "commander";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { loadConfig, loadReactions, saveReactions, resolveHome } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import { runAutoStatus } from "../reactor/auto-status.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_DIR = path.join(os.homedir(), ".config", "cockpit");
const STATE_FILE = path.join(CONFIG_DIR, "reactor-state.json");

function getScriptsDir(): string {
  const candidates = [
    path.join(__dirname, "..", "..", "scripts"),
    path.join(os.homedir(), ".config", "cockpit", "scripts"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "reactor-cycle.sh"))) {
      return dir;
    }
  }
  return candidates[0];
}

function checkGhCli(): boolean {
  try {
    execSync("gh auth status", { stdio: "pipe" });
    return true;
  } catch {
    try {
      execSync("which gh", { stdio: "pipe" });
      console.log(chalk.yellow("\n  ⚠ gh CLI is not authenticated. Run: gh auth login\n"));
    } catch {
      console.log(chalk.yellow("\n  ⚠ gh CLI not found. Install it: brew install gh"));
      console.log(chalk.dim("  Then authenticate: gh auth login\n"));
    }
    return false;
  }
}

export const reactorCommand = new Command("reactor")
  .description("Manage the reaction engine — poll GitHub, match events, execute actions")

// cockpit reactor check — run one poll cycle
reactorCommand
  .command("check")
  .description("Run one reaction cycle (poll → match → execute)")
  .option("--dry-run", "Show matched actions without executing them")
  .action(async (opts: { dryRun?: boolean }) => {
    if (!checkGhCli()) return;

    const config = loadConfig();
    const reactions = loadReactions();
    const repos = reactions.github?.repos || {};
    const repoCount = Object.keys(repos).length;

    if (repoCount === 0) {
      console.log(chalk.yellow("\n  No GitHub repos configured. Add one with: cockpit reactor add <project>\n"));
      return;
    }

    console.log(chalk.bold(`\n  ⚡ Running reaction cycle (${repoCount} repos)\n`));

    if (Object.keys(config.projects).length > 0 && reactions.auto_status?.enabled !== false) {
      console.log(chalk.dim("  Polling captain panes (auto-status)..."));
      const registry = new RuntimeRegistry({ cmux: createCmuxDriver() });
      const results = await runAutoStatus({
        config,
        reactions,
        runtime: (project) => registry.forProject(project, config),
      });
      for (const r of results) {
        console.log(chalk.dim(`    ${r.project.padEnd(16)} ${r.state}`));
      }
    }

    const scriptsDir = getScriptsDir();
    const cycleScript = path.join(scriptsDir, "reactor-cycle.sh");

    if (!fs.existsSync(cycleScript)) {
      console.error(chalk.red(`  ✘ Script not found: ${cycleScript}`));
      console.log(chalk.dim(`  Run 'cockpit init' to deploy scripts.\n`));
      return;
    }

    try {
      if (opts.dryRun) {
        // Poll and match only, don't execute
        const pollScript = path.join(scriptsDir, "poll-github.sh");
        const matchScript = path.join(scriptsDir, "match-reactions.sh");
        const eventsFile = path.join(CONFIG_DIR, "reactor-events", "dry-run.json");
        fs.mkdirSync(path.dirname(eventsFile), { recursive: true });

        console.log(chalk.dim("  Polling GitHub..."));
        execSync(`"${pollScript}" > "${eventsFile}"`, { stdio: ["pipe", "pipe", "inherit"] });

        console.log(chalk.dim("  Matching reactions..."));
        const actions = execSync(`"${matchScript}" "${eventsFile}"`, { encoding: "utf-8" });
        const parsed = JSON.parse(actions);

        if (parsed.length === 0) {
          console.log(chalk.green("  ✔ No actions to execute\n"));
        } else {
          console.log(chalk.bold(`\n  ${parsed.length} action(s) would execute:\n`));
          for (const action of parsed) {
            const icon = action.priority === "high" ? "🚨" : "→";
            console.log(`  ${icon} ${chalk.cyan(action.rule)}: ${action.action} → ${action.project} #${action.number || ""}`);
            if (action.message) {
              console.log(chalk.dim(`    ${action.message.split("\n")[0].slice(0, 80)}`));
            }
          }
          console.log("");
        }
        fs.rmSync(eventsFile, { force: true });
      } else {
        const output = execSync(`"${cycleScript}"`, { encoding: "utf-8", stdio: ["pipe", "pipe", "inherit"] });
        console.log(output);
      }
    } catch (err) {
      console.error(chalk.red(`  ✘ Cycle failed: ${(err as Error).message}`));
    }
  });

// cockpit reactor status — show reactor state
reactorCommand
  .command("status")
  .description("Show reactor state and last poll info")
  .action(() => {
    const reactions = loadReactions();
    const ghOk = checkGhCli();

    console.log(chalk.bold("\n  ⚡ Reactor Status\n"));
    console.log(`  ${chalk.dim("gh CLI:")}        ${ghOk ? chalk.green("authenticated") : chalk.red("not ready")}`);

    // Config summary
    const repos = reactions.github?.repos || {};
    const repoCount = Object.keys(repos).length;
    const enabledRules = Object.entries(reactions.reactions || {})
      .filter(([_, r]) => r.enabled !== false)
      .map(([name]) => name);

    console.log(`  ${chalk.dim("Poll interval:")} ${reactions.engine?.poll_interval || "5m"}`);
    console.log(`  ${chalk.dim("Repos watched:")} ${repoCount}`);
    for (const [name, repo] of Object.entries(repos)) {
      console.log(`    ${chalk.cyan(name)} → ${repo.owner}/${repo.repo}`);
    }

    console.log(`  ${chalk.dim("Active rules:")}  ${enabledRules.length}`);
    for (const rule of enabledRules) {
      console.log(`    ${chalk.green("●")} ${rule}`);
    }

    const disabledRules = Object.entries(reactions.reactions || {})
      .filter(([_, r]) => r.enabled === false)
      .map(([name]) => name);
    if (disabledRules.length > 0) {
      console.log(`  ${chalk.dim("Disabled rules:")} ${disabledRules.length}`);
      for (const rule of disabledRules) {
        console.log(`    ${chalk.dim("○")} ${rule}`);
      }
    }

    // GitHub Project
    if (reactions.github?.project) {
      const proj = reactions.github.project;
      console.log(`  ${chalk.dim("GitHub Project:")} ${proj.owner}#${proj.number}`);
    }

    // State
    if (fs.existsSync(STATE_FILE)) {
      try {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
        const lastPoll = state.last_poll;
        const processedCount = Object.keys(state.processed_events || {}).length;

        console.log(`\n  ${chalk.dim("Last poll:")}      ${lastPoll || "never"}`);
        console.log(`  ${chalk.dim("Events tracked:")} ${processedCount}`);
      } catch {
        console.log(`\n  ${chalk.dim("State file:")} ${chalk.yellow("corrupted")}`);
      }
    } else {
      console.log(`\n  ${chalk.dim("Last poll:")}      ${chalk.yellow("never run")}`);
    }

    console.log("");
  });

// cockpit reactor add <project> — wire up a project for reactor watching
reactorCommand
  .command("add")
  .description("Add a project's GitHub repo to reactor watch list")
  .argument("<project>", "Project name (must exist in cockpit config)")
  .option("--owner <owner>", "GitHub owner/org (auto-detected from git remote if omitted)")
  .option("--repo <repo>", "GitHub repo name (auto-detected from git remote if omitted)")
  .action((project: string, opts: { owner?: string; repo?: string }) => {
    const config = loadConfig();
    const reactions = loadReactions();

    if (!config.projects[project]) {
      console.error(chalk.red(`\n  ✘ Project '${project}' not found in cockpit config.`));
      console.log(chalk.dim("  Run 'cockpit projects list' to see registered projects.\n"));
      process.exit(1);
    }

    let owner = opts.owner;
    let repo = opts.repo;

    // Auto-detect from git remote
    if (!owner || !repo) {
      const projPath = resolveHome(config.projects[project].path);
      try {
        const remoteUrl = execSync(`git -C "${projPath}" remote get-url origin`, { encoding: "utf-8" }).trim();
        // Parse: git@github.com:owner/repo.git or https://github.com/owner/repo.git
        const sshMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
        if (sshMatch) {
          owner = owner || sshMatch[1];
          repo = repo || sshMatch[2];
        }
      } catch {
        if (!owner || !repo) {
          console.error(chalk.red("\n  ✘ Could not detect GitHub remote. Specify --owner and --repo manually.\n"));
          process.exit(1);
        }
      }
    }

    if (!owner || !repo) {
      console.error(chalk.red("\n  ✘ Could not determine owner/repo. Specify --owner and --repo manually.\n"));
      process.exit(1);
    }

    // Add to reactions config
    if (!reactions.github) {
      reactions.github = { repos: {} };
    }
    if (!reactions.github.repos) {
      reactions.github.repos = {};
    }

    const existed = !!reactions.github.repos[project];
    reactions.github.repos[project] = { owner, repo };
    saveReactions(reactions);

    if (existed) {
      console.log(chalk.green(`\n  ✔ Updated ${project} → ${owner}/${repo}\n`));
    } else {
      console.log(chalk.green(`\n  ✔ Added ${project} → ${owner}/${repo}`));
      console.log(chalk.dim(`  Reactor will now watch this repo. Test with: cockpit reactor check --dry-run\n`));
    }
  });

// cockpit reactor remove <project> — stop watching a project
reactorCommand
  .command("remove")
  .description("Remove a project from reactor watch list")
  .argument("<project>", "Project name")
  .action((project: string) => {
    const reactions = loadReactions();

    if (!reactions.github?.repos?.[project]) {
      console.log(chalk.yellow(`\n  Project '${project}' is not in the reactor watch list.\n`));
      return;
    }

    delete reactions.github.repos[project];
    saveReactions(reactions);
    console.log(chalk.green(`\n  ✔ Removed '${project}' from reactor watch list.\n`));
  });

// cockpit reactor list — show watched repos
reactorCommand
  .command("list")
  .description("List all repos the reactor is watching")
  .action(() => {
    const reactions = loadReactions();
    const repos = reactions.github?.repos || {};
    const entries = Object.entries(repos);

    if (entries.length === 0) {
      console.log(chalk.yellow("\n  No repos configured. Add one with: cockpit reactor add <project>\n"));
      return;
    }

    console.log(chalk.bold("\n  Reactor Watch List\n"));
    for (const [name, repo] of entries) {
      console.log(`  ${chalk.cyan(name)} → ${repo.owner}/${repo.repo}`);
    }
    console.log("");
  });

// cockpit reactor config — quick edit helper
reactorCommand
  .command("config")
  .description("Show path to reactions.json for editing")
  .action(() => {
    const configPath = path.join(CONFIG_DIR, "reactions.json");
    if (fs.existsSync(configPath)) {
      console.log(chalk.bold(`\n  Reactions config: ${configPath}\n`));
    } else {
      console.log(chalk.yellow(`\n  No reactions.json found at ${configPath}`));
      console.log(chalk.dim("  Run 'cockpit init' to deploy the default config.\n"));
    }
  });

// cockpit reactor reset — clear processed events state
reactorCommand
  .command("reset")
  .description("Clear reactor state (re-process all events on next poll)")
  .action(() => {
    if (fs.existsSync(STATE_FILE)) {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        processed_events: {},
        pending_retries: {},
        last_poll: null,
      }, null, 2));
      console.log(chalk.green("\n  ✔ Reactor state cleared. All events will be re-evaluated on next poll.\n"));
    } else {
      console.log(chalk.dim("\n  No state file to clear.\n"));
    }
  });

// cockpit reactor poll-status — run one auto-status poll across registered projects
reactorCommand
  .command("poll-status")
  .description("Read each captain's pane, classify state, write {spokeVault}/status.md")
  .option("--json", "Emit results as JSON instead of human output")
  .action(async (opts: { json?: boolean }) => {
    const config = loadConfig();
    const reactions = loadReactions();

    if (Object.keys(config.projects).length === 0) {
      if (opts.json) {
        console.log("[]");
      } else {
        console.log(chalk.yellow("\n  No projects registered. Add one with: cockpit projects add <name> <path>\n"));
      }
      return;
    }

    const registry = new RuntimeRegistry({ cmux: createCmuxDriver() });
    const results = await runAutoStatus({
      config,
      reactions,
      runtime: (project) => registry.forProject(project, config),
    });

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log(chalk.dim("\n  Auto-status disabled in reactions.json (auto_status.enabled = false).\n"));
      return;
    }

    console.log(chalk.bold("\n  📊 Auto-status poll\n"));
    for (const r of results) {
      const icon = ({
        idle: chalk.green("●"),
        busy: chalk.cyan("◐"),
        blocked: chalk.yellow("⏸"),
        errored: chalk.red("✗"),
        offline: chalk.dim("○"),
      } as const)[r.state];
      console.log(`  ${icon} ${chalk.cyan(r.project.padEnd(16))} ${r.state.padEnd(8)} → ${chalk.dim(r.vaultPath)}`);
    }
    console.log("");
  });
