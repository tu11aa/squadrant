import { Command } from "commander";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig, resolveHome } from "@cockpit/shared";
import type { ModelRoutingConfig } from "@cockpit/shared";
import { createClaudeDriver, createCodexDriver, createGeminiDriver, createOpencodeDriver, CapabilityRegistry, buildAgentCmd } from "@cockpit/agents";
import type { AgentDriver } from "@cockpit/agents";
import { RuntimeRegistry, createCmuxDriver, createObsidianDriver, WorkspaceRegistry, isInsideCmux, cmuxLocal } from "@cockpit/workspaces";
import type { RuntimeDriver } from "@cockpit/workspaces";
import { ensureSpokeLayout } from "@cockpit/shared";
import { classifyStartupSurface } from "@cockpit/workspaces";
import { shouldStartFresh, recordSession } from "@cockpit/core";

const CMUX_APP = "/Applications/cmux.app";
const TEMPLATES_DIR = path.join(os.homedir(), ".config", "cockpit", "templates");
const SESSIONS_PATH = path.join(os.homedir(), ".config", "cockpit", "sessions.json");

function ensureCmuxReady(): void {
  if (isInsideCmux()) return;

  console.log(chalk.yellow("\n  Not running inside cmux. Opening cmux app...\n"));
  execSync(`open "${CMUX_APP}"`, { stdio: "inherit" });
  console.log(chalk.bold("  Run `cockpit launch` from inside a cmux workspace.\n"));
  process.exit(0);
}

export interface StartupDeliveryOptions {
  /** Max time to wait for the surface to leave the cold-init splash. */
  readyTimeoutMs?: number;
  /** Pause after a send before checking whether the turn started. */
  settleMs?: number;
  /** Poll cadence while waiting for readiness. */
  pollMs?: number;
  /** Hard cap on (re)send attempts. */
  maxAttempts?: number;
}

/**
 * #292: deliver the captain/command startup prompt deterministically instead of
 * on a fixed 8s timer. CC cold-init takes 5–15s, so a fixed delay either wastes
 * boot time or — on a slow boot — drops the prompt on the splash screen (#235),
 * leaving the captain idle and the relay unbooted.
 *
 * The loop, per attempt: (1) poll until the surface is past the splash; (2) if a
 * turn is already running, stop — never queue a duplicate startup run; (3) send;
 * (4) after a short settle, re-check — a real submit flips the surface to
 * "working", so we re-send ONLY while it's still "idle" (keystrokes were dropped).
 * Re-sending strictly on observed-still-idle is what guards against duplicate
 * runs: a prompt that landed is never sent twice. Best-effort and never throws.
 */
export async function deliverStartupPrompt(
  runtime: Pick<RuntimeDriver, "readScreen" | "send">,
  refId: string,
  prompt: string,
  opts: StartupDeliveryOptions = {},
): Promise<void> {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  const settleMs = opts.settleMs ?? 2_500;
  const pollMs = opts.pollMs ?? 1_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const read = async () => runtime.readScreen(refId).catch(() => "");

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Phase 1 — wait out cold init (poll, don't guess with a fixed delay).
    // Keep the last-read screen as the pre-send baseline for the Phase-3 check.
    const deadline = Date.now() + readyTimeoutMs;
    let preSend = await read();
    let state = classifyStartupSurface(preSend);
    while (state === "loading" && Date.now() < deadline) {
      await sleep(pollMs);
      preSend = await read();
      state = classifyStartupSurface(preSend);
    }

    // A turn is already in flight (a prior attempt landed, or a resumed session
    // auto-continued). Never keystroke into it — that would queue a duplicate run.
    if (state === "working") return;

    // Phase 2 — deliver. We send on "idle" (input-ready) and, as a non-hanging
    // fallback, on a "loading" timeout (e.g. a non-Claude agent whose chrome we
    // don't recognize) so a launch is never left silently without its prompt.
    await runtime.send(refId, prompt).catch(() => { /* best-effort */ });

    // Timed out waiting for chrome — sent blind once; nothing to confirm, stop.
    if (state === "loading") return;

    // Phase 3 — confirm by whether the surface CHANGED, not by re-matching a
    // working-spinner. The old guard re-sent "while still idle", relying on
    // classifyStartupSurface → CC_WORKING_RE matching the live spinner. The newer
    // CC renders the early turn as a bare "✽ Synthesizing…" (no timer/token/shell
    // marker) and streams "⏺ Thinking…" with no spinner line at all — none of
    // which CC_WORKING_RE matches — so a captain that ALREADY accepted the prompt
    // and is busy thinking reads as "idle" at the +settleMs sample, and the loop
    // re-sends → duplicate startup run (cmux/CC render drift, audit A3; the code
    // is unchanged since v0.6.2). A LANDED prompt always mutates the surface (the
    // submitted message echoes into the transcript and the turn begins); DROPPED
    // keystrokes (#235) leave the surface byte-identical to the pre-send baseline.
    // Re-send only on no-change — robust to whatever the spinner renders as.
    await sleep(settleMs);
    const after = await read();
    if (after !== preSend) return;
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
): Promise<void> {
  ensureCmuxReady();

  const existing = await runtime.status(name);
  if (existing && forceFresh) {
    console.log(chalk.yellow(`  Closing stale workspace '${name}' for fresh start`));
    await runtime.stop(existing.id);
  } else if (existing) {
    console.log(chalk.yellow(`  Workspace '${name}' already exists — switching to it`));
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
    // #292: deterministic delivery — poll for input-readiness, send, and bounded
    // re-send if the first turn was dropped (replaces the racy fixed 8s delay
    // that dropped the prompt on slow 5–15s cold boots). Fire-and-forget, as the
    // old setTimeout was, so launch stays non-blocking and `--all` dispatches
    // captains in parallel; the loop's pending poll timers keep the CLI process
    // alive until delivery completes.
    void deliverStartupPrompt(runtime, ref.id, initialPrompt);
  }

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
        const auto = shouldStartFresh(workspaceName, role, { sessionsPath: SESSIONS_PATH, templatesDir: TEMPLATES_DIR });
        if (auto.fresh) {
          console.log(chalk.cyan(`  ↻ ${auto.reason}`));
          forceFresh = true;
        }
      }

      const roleConfig = config.defaults.roles?.[role as keyof NonNullable<typeof config.defaults.roles>];
      const agentName = roleConfig?.agent || "claude";
      const model = roleConfig?.model || config.defaults.models?.[role as keyof ModelRoutingConfig];
      const agentCmd = buildAgentCmd(agentName, registry, role, forceFresh, permissionMode, model, TEMPLATES_DIR);
      recordSession(workspaceName, role, { sessionsPath: SESSIONS_PATH, templatesDir: TEMPLATES_DIR });

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
        await launchWorkspace(runtime, workspaceName, agentCmd, cwd, navigate, forceFresh, pinToTop, initialPrompt);
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
