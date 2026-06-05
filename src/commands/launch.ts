import { Command } from "commander";
import { execSync, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig, resolveHome, type ModelRoutingConfig } from "../config.js";
import { createClaudeDriver, createCodexDriver, createGeminiDriver, createOpencodeDriver, CapabilityRegistry } from "../drivers/index.js";
import type { AgentDriver, Role } from "../drivers/types.js";
import { RuntimeRegistry, createCmuxDriver } from "../runtimes/index.js";
import type { RuntimeDriver, WorkspaceRef } from "../runtimes/index.js";
import { createObsidianDriver, WorkspaceRegistry } from "../workspaces/index.js";
import { ensureSpokeLayout } from "../lib/vault-layout.js";
import { resolveCmuxBin } from "../lib/cmux-bin.js";
import { buildRelaySupervisorCommand, NOTIFY_RELAY_TAB_TITLE } from "../control/relay-supervisor.js";
import { CMUX_TIMEOUT } from "../runtimes/cmux.js";

const CMUX_APP = "/Applications/cmux.app";
const TEMPLATES_DIR = path.join(os.homedir(), ".config", "cockpit", "templates");
const SESSIONS_PATH = path.join(os.homedir(), ".config", "cockpit", "sessions.json");

// Direct cmux invocation for the select-workspace / current-workspace calls
// not yet abstracted behind RuntimeDriver. Uses execFileSync (no shell) with
// stderr piped, NOT inherited — cmux prints diagnostics like
// "Error: not_found: Pane not found" to stderr and exits 0 when focusing a
// surface that vanished mid-launch (e.g. --fresh closes a stale workspace).
// The default execSync/execFileSync stdio forwards that stderr to the parent
// terminal, which is exactly the #121 Issue B leak. Capturing fd 2 here
// swallows it. Returns trimmed stdout for callers that need it.
export function cmuxLocal(args: string[]): string {
  return execFileSync(resolveCmuxBin(), args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: CMUX_TIMEOUT }).trim();
}

interface SessionRecord {
  lastLaunched: string; // YYYY-MM-DD
  templateHash: string;
}

interface SessionsFile {
  workspaces: Record<string, SessionRecord>;
}

function loadSessions(): SessionsFile {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf-8"));
  } catch {
    return { workspaces: {} };
  }
}

function saveSessions(sessions: SessionsFile): void {
  const dir = path.dirname(SESSIONS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2) + "\n");
}

function computeTemplateHash(role: string): string {
  const hash = crypto.createHash("sha256");

  // Hash the role template
  const roleFile = path.join(TEMPLATES_DIR, `${role}.claude.md`);
  const legacyRoleFile = path.join(TEMPLATES_DIR, `${role}.CLAUDE.md`);
  if (fs.existsSync(roleFile)) {
    hash.update(fs.readFileSync(roleFile, "utf-8"));
  } else if (fs.existsSync(legacyRoleFile)) {
    hash.update(fs.readFileSync(legacyRoleFile, "utf-8"));
  }

  // Also hash plugin skills so template changes trigger fresh sessions
  const pluginSkillsDir = path.join(TEMPLATES_DIR, "..", "plugin", "skills");
  if (fs.existsSync(pluginSkillsDir)) {
    for (const skill of fs.readdirSync(pluginSkillsDir).sort()) {
      const skillFile = path.join(pluginSkillsDir, skill, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        hash.update(fs.readFileSync(skillFile, "utf-8"));
      }
    }
  }

  return hash.digest("hex").slice(0, 16);
}

function shouldStartFresh(
  workspaceName: string,
  role: string,
): { fresh: boolean; reason?: string } {
  const sessions = loadSessions();
  const record = sessions.workspaces[workspaceName];
  const today = new Date().toISOString().slice(0, 10);
  const currentHash = computeTemplateHash(role);

  if (!record) {
    return { fresh: true, reason: "first launch" };
  }

  if (record.lastLaunched !== today) {
    return { fresh: true, reason: "new day — starting fresh session" };
  }

  if (record.templateHash !== currentHash) {
    return { fresh: true, reason: "template instructions updated" };
  }

  return { fresh: false };
}

function recordSession(workspaceName: string, role: string): void {
  const sessions = loadSessions();
  sessions.workspaces[workspaceName] = {
    lastLaunched: new Date().toISOString().slice(0, 10),
    templateHash: computeTemplateHash(role),
  };
  saveSessions(sessions);
}

function isInsideCmux(): boolean {
  return !!process.env.CMUX_WORKSPACE_ID;
}

function ensureCmuxReady(): void {
  if (isInsideCmux()) return;

  console.log(chalk.yellow("\n  Not running inside cmux. Opening cmux app...\n"));
  execSync(`open "${CMUX_APP}"`, { stdio: "inherit" });
  console.log(chalk.bold("  Run `cockpit launch` from inside a cmux workspace.\n"));
  process.exit(0);
}

function buildAgentCmd(
  agentName: string,
  registry: CapabilityRegistry,
  role: string,
  fresh: boolean,
  permissionMode: string,
  model?: string,
): string {
  const driver = registry.getDriver(agentName);

  // For Claude, handle fresh vs continue and permission mode specially
  if (driver.name === "claude") {
    let cmd = fresh ? "claude" : "claude -c";

    if (permissionMode === "acceptEdits") {
      cmd += " --permission-mode acceptEdits";
    } else if (permissionMode === "auto") {
      cmd += " --permission-mode auto";
    } else if (permissionMode === "bypassPermissions") {
      cmd += " --dangerously-skip-permissions";
    }

    if (model) {
      cmd += ` --model ${model}`;
    }

    const roleFile = path.join(TEMPLATES_DIR, `${role}.claude.md`);
    const legacyRoleFile = path.join(TEMPLATES_DIR, `${role}.CLAUDE.md`);
    const actualRoleFile = fs.existsSync(roleFile) ? roleFile : (fs.existsSync(legacyRoleFile) ? legacyRoleFile : null);
    if (actualRoleFile) {
      cmd += ` --append-system-prompt-file ${actualRoleFile}`;
    }

    const pluginDir = path.join(TEMPLATES_DIR, "..", "plugin");
    if (fs.existsSync(pluginDir)) {
      cmd += ` --plugin-dir ${pluginDir}`;
    }

    return cmd;
  }

  // For non-Claude agents, use the driver's buildCommand
  const roleFile = path.join(TEMPLATES_DIR, `${role}.${driver.templateSuffix}.md`);
  return driver.buildCommand({
    prompt: `You are a cockpit ${role}. Read your instructions from ${roleFile} and begin.`,
    workdir: process.cwd(),
    role: role as Role,
    model,
    autoApprove: true,
    promptFile: fs.existsSync(roleFile) ? roleFile : undefined,
  });
}

// Relay-tab builders moved to src/control/relay-supervisor.ts (shared with the
// daemon's #207 healer). Re-exported for back-compat (launch.test.ts imports
// them from "../launch").
export { buildRelaySupervisorCommand, NOTIFY_RELAY_TAB_TITLE };

/**
 * Add the notify-relay to a captain workspace as a background tab. The
 * relay tails the daemon's per-project mailbox and forwards each new event to
 * the captain pane via runtime.sendToSurface — required because cmux refuses
 * any caller not descended from its app process, so the daemon itself cannot
 * deliver. Dedups by closing any pre-existing relay surface before respawning,
 * so the relay always boots fresh with the current cockpit binary.
 */
async function ensureNotifyRelayTab(
  runtime: RuntimeDriver,
  workspace: WorkspaceRef,
  project: string,
): Promise<void> {
  try {
    const surfaces = await runtime.listSurfaces(workspace.id);
    for (const s of surfaces) {
      if (s.title === NOTIFY_RELAY_TAB_TITLE) {
        try { await runtime.closePane(s); } catch { /* best effort */ }
      }
    }
    await runtime.spawnInjector({
      captainWorkspace: workspace,
      command: buildRelaySupervisorCommand(project),
      title: NOTIFY_RELAY_TAB_TITLE,
      placement: "background",
    });
    console.log(chalk.cyan(`  ✔ Added background notify-relay for '${project}'`));
  } catch (e) {
    console.error(chalk.yellow(`  ⚠ notify-relay setup failed: ${(e as Error).message}`));
  }
}

async function launchWorkspace(
  runtime: RuntimeDriver,
  name: string,
  agentCmd: string,
  cwd?: string,
  navigate = false,
  forceFresh = false,
  pinToTop = false,
  initialPrompt?: string,
  notifyRelayProject?: string,
): Promise<void> {
  ensureCmuxReady();

  const existing = await runtime.status(name);
  if (existing && forceFresh) {
    console.log(chalk.yellow(`  Closing stale workspace '${name}' for fresh start`));
    await runtime.stop(existing.id);
  } else if (existing) {
    console.log(chalk.yellow(`  Workspace '${name}' already exists — switching to it`));
    if (notifyRelayProject) await ensureNotifyRelayTab(runtime, existing, notifyRelayProject);
    // TODO(runtime): select/focus not yet abstracted; direct cmux call retained intentionally
    cmuxLocal(["select-workspace", "--workspace", existing.id]);
    return;
  }

  let currentRef: string | undefined;
  try {
    // TODO(runtime): current-workspace not yet abstracted
    const cur = cmuxLocal(["current-workspace"]);
    currentRef = cur.match(/workspace:\d+/)?.[0];
  } catch { /* ignore */ }

  const ref = await runtime.spawn({
    name,
    workdir: cwd ?? process.cwd(),
    command: agentCmd,
    pinToTop,
  });

  if (initialPrompt) {
    // Small delay to let agent initialize before sending prompt
    setTimeout(() => {
      runtime.send(ref.id, initialPrompt).catch(() => { /* best-effort */ });
    }, 3000);
  }

  if (notifyRelayProject) await ensureNotifyRelayTab(runtime, ref, notifyRelayProject);

  if (navigate) {
    // TODO(runtime): select not yet abstracted
    cmuxLocal(["select-workspace", "--workspace", ref.id]);
  } else if (currentRef) {
    // TODO(runtime): select not yet abstracted
    cmuxLocal(["select-workspace", "--workspace", currentRef]);
  }

  console.log(chalk.green(`  ✔ Workspace '${name}' created`));
}

export const launchCommand = new Command("launch")
  .description(
    "Launch a project captain (with project arg) or all captains (--all). Use `cockpit command` for one-shot Command tasks.",
  )
  .argument("[project]", "Project name to launch captain for")
  .option("--fresh", "Start a new session instead of resuming the last one")
  .option("--all", "Launch all captain workspaces")
  .action(async (project: string | undefined, opts: { fresh?: boolean; all?: boolean }) => {
    const config = loadConfig();

    // Build agent driver registry
    const drivers: Record<string, AgentDriver> = {
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
      let forceFresh = !!opts.fresh;
      if (!forceFresh) {
        const auto = shouldStartFresh(workspaceName, role);
        if (auto.fresh) {
          console.log(chalk.cyan(`  ↻ ${auto.reason}`));
          forceFresh = true;
        }
      }

      const roleConfig = config.defaults.roles?.[role as keyof NonNullable<typeof config.defaults.roles>];
      const agentName = roleConfig?.agent || "claude";
      const model = roleConfig?.model || config.defaults.models?.[role as keyof ModelRoutingConfig];
      const agentCmd = buildAgentCmd(agentName, registry, role, forceFresh, permissionMode, model);
      recordSession(workspaceName, role);

      // Auto-trigger startup checklist
      let initialPrompt: string | undefined;
      if (role === "captain") {
        initialPrompt = "Run your startup checklist: use the cockpit:captain-ops skill, complete all startup steps, then report ready.";
      } else if (role === "command") {
        initialPrompt = "Run your startup checklist: use the cockpit:command-ops skill, complete your daily briefing, then report ready.";
      }

      const runtime = projectName
        ? runtimes.forProject(projectName, config)
        : runtimes.global(config);

      try {
        // #111: only captain workspaces need the notify-relay tab — they're the
        // ones that receive crew terminal-event push notifications. Command
        // doesn't supervise crews.
        const notifyRelayProject = role === "captain" ? projectName : undefined;
        await launchWorkspace(runtime, workspaceName, agentCmd, cwd, navigate, forceFresh, pinToTop, initialPrompt, notifyRelayProject);
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
      console.error(
        chalk.red(
          "\n  ✘ Specify a project name, or pass --all to launch every captain.\n" +
            "    For one-shot Command tasks, use `cockpit command --task <briefing|learnings-review|wiki-aggregate>`.\n",
        ),
      );
      process.exit(1);
    } else {
      // Launch captain workspace for a project
      if (!config.projects[project]) {
        console.error(
          chalk.red(
            `\n  ✘ Project '${project}' not found. Run 'cockpit projects list' to see registered projects.\n`,
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
