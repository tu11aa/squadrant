// src/commands/launch.ts
//
// Thin wrapper: parse args → construct CLI-edge deps → call launchOneWorkspace → format.
// Workspace-boot orchestration lives in @squadrant/core (launch-workspace.ts, #367).

import { Command } from "commander";
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { loadConfig, resolveHome, ensureSpokeLayout, resolveCaptainChannelMode, captainSessionName, parseThinkingLevel, isBackendMode, THINKING_LEVELS } from "@squadrant/shared";
import type { BackendMode, ModelRoutingConfig, ThinkingLevel } from "@squadrant/shared";
import {
  createClaudeDriver, createCodexDriver, createGeminiDriver, createOpencodeDriver,
  CapabilityRegistry, buildAgentCmd,
} from "@squadrant/agents";
import {
  RuntimeRegistry, createCmuxDriver, createObsidianDriver, WorkspaceRegistry,
  isInsideCmux, cmuxLocal, classifyStartupSurface, classifyOpencodeStartupSurface, getFreePort,
} from "@squadrant/workspaces";
import {
  launchOneWorkspace, loadSessions, ensureSocksDir, captainSocketPath,
  readCaptainAddress, writeCaptainAddress, realpathOrSelf, resolveAndPersistOpencodeCaptain,
  discoverLiveOpencodeServer, prepareCaptainRoute, renderEnvAssignments,
  type CaptainAddress, type CaptainRouteSetup,
} from "@squadrant/core";
import { selectCaptainsInteractive } from "./launch-interactive.js";
import type { CaptainEntry } from "./launch-interactive.js";
import { resolveLaunchAgent, resolveLaunchBackend } from "../lib/launch-agent-resolve.js";
import { isBlockedFallback, anthropicRefusalMessage } from "../lib/model-guard.js";
import { readGlobalOpencodeModel, writePerCrewOpencodeConfig, writeRouterSettings } from "../lib/per-crew-settings.js";
import { fetchRouterCredentials } from "./crew.js";
import { squadrantdCall } from "./crew-control.js";

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
// the same /tmp/cc-socks/squadrant-captain-undefined.sock (first bind wins,
// the rest are refused by Claude Code's live-socket guard and never start).
// Delegates to @squadrant/core's captainSocketPath — the two formulas must
// stay byte-identical (see captain-channel.ts's header comment) — and fails
// loudly if no project name reached this call at all, since core's name-safety
// regex would otherwise happily accept the literal string "undefined".
// Exported for testing (see launch.test.ts).
export function resolveCaptainSocketPath(
  captainChannelEnabled: boolean,
  projectName: string | undefined,
  workspaceName: string,
): string | undefined {
  if (!captainChannelEnabled) return undefined;
  if (!projectName) {
    throw new Error(`launch: captain channel requires a project name, but none was provided for workspace '${workspaceName}'`);
  }
  return captainSocketPath(projectName);
}

// #708: only claude honours `-n` — gate on the agent, not the role, since
// launchOne is claude-only for captains today (agents without this
// capability just never see the flag). Purely cosmetic (unlike the socket
// path), so a missing project name yields no name rather than throwing.
export function resolveCaptainSessionName(agentName: string, projectName: string | undefined): string | undefined {
  if (agentName !== "claude" || !projectName) return undefined;
  return captainSessionName(projectName);
}

/** #786: resume is explicit and agent-matched — never `-c` (spec §2 test 9).
 *  #797: `fresh` (CLI --fresh, or the auto-fresh new-day/template reasons) must
 *  suppress the resume id, otherwise `--fresh` still runs `opencode --session
 *  <old>` and reopens the session it was meant to replace. */
export function pickResumeSessionId(
  record: Pick<CaptainAddress, "agent" | "sessionId"> | null,
  agentName: string,
  fresh = false,
): string | undefined {
  if (fresh) return undefined;
  if (!record || record.agent !== agentName) return undefined;
  return record.sessionId;
}

/** #786: opencode puts a commit-less directory in the shared `global` project
 *  (resume spike §T1), so such a directory is not a valid opencode captain home. */
export function isOpencodeCaptainDir(dir: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--verify", "HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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
  .option("--thinking <level>", `Override captain thinking level for this launch (${THINKING_LEVELS.join("|")}) → claude --effort; takes precedence over defaults.roles.captain.thinking`)
  .option("--backend <mode>", "Override captain backend for this launch (native|direct|proxy); takes precedence over defaults.roles.captain.backend")
  .action(async (project: string | undefined, opts: { fresh?: boolean; keep?: boolean; all?: boolean; headless?: boolean; agent?: string; model?: string; thinking?: string; backend?: string }) => {
    if (opts.fresh && opts.keep) {
      console.error(chalk.red("\n  ✘ --fresh and --keep are mutually exclusive\n"));
      process.exit(1);
    }

    // Fail fast on a typo rather than booting the wrong upstream.
    if (opts.backend !== undefined && !isBackendMode(opts.backend)) {
      console.error(chalk.red(`\n  ✘ Invalid --backend value '${opts.backend}'. Valid values: native, direct, proxy\n`));
      process.exit(1);
    }
    const backendOverride: BackendMode | undefined = opts.backend;

    // Fail fast on a typo rather than letting the claude CLI warn and fall
    // back to its default effort — a silently-ignored flag is worse than an error.
    let thinkingOverride: ThinkingLevel | undefined;
    try {
      thinkingOverride = opts.thinking ? parseThinkingLevel(opts.thinking) : undefined;
    } catch (err) {
      console.error(chalk.red(`\n  ✘ ${(err as Error).message}\n`));
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
      const { agentName, model, thinking } = resolveLaunchAgent(
        { agent: opts.agent, model: opts.model, thinking: thinkingOverride },
        roleConfig,
        config.defaults.models?.[role as keyof ModelRoutingConfig],
      );
      // #772 follow-up: resolve the launch backend the same way crew spawn does
      // (explicit --backend > roles.<role>.backend > native; role backend only
      // when the resolved agent is claude, since direct/proxy are claude-only).
      const backend = resolveLaunchBackend({ backendOverride, agentName, roleConfig });

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

      const stateRoot = path.join(os.homedir(), ".config", "squadrant", "state");
      const isOpencodeCaptain = role === "captain" && agentName === "opencode" && !!projectName;

      if (isOpencodeCaptain && !isOpencodeCaptainDir(cwd)) {
        console.error(chalk.red(`\n  ✘ '${projectName}' is not a git repo with a commit — an opencode captain needs a stable project identity. Run 'git commit' first.\n`));
        hadFailure = true;
        return;
      }

      // An opencode crew gets an allow-all per-task config + OPENCODE_CONFIG
      // prefix (crew-spawn.ts) so it never blocks on a tool approval. The
      // captain path goes through buildAgentCmd's interactive branch instead,
      // which ignores autoApprove and returns a bare `opencode …` command — so
      // the captain inherited only the global config (no `permission` block)
      // and prompted on every bash/edit. Mirror the crew mechanism at the CLI
      // edge: write an allow-all captain config and prefix the command. No
      // gateBash — the captain must stay fully autonomous.
      let captainOpencodeConfigPath: string | undefined;
      if (isOpencodeCaptain && projectName) {
        captainOpencodeConfigPath = writePerCrewOpencodeConfig({ stateRoot, project: projectName, taskId: "captain" });
      }

      // #772 follow-up: a router-backed captain must run the U7 permission gate
      // instead of the built-in auto-mode classifier (hardcoded to Claude Sonnet
      // 5, fails CLOSED on a router that does not serve it → "bash denied by auto
      // mode"). prepareCaptainRoute picks permission_mode=default + SQUADRANT_GATE=on
      // and writes the per-spawn --settings file carrying the router env, and
      // fails LOUD if the credentials fetch or settings writer is missing rather
      // than launching a routed captain that silently bypasses the shim. Native
      // is byte-for-byte unchanged. Captains only — command/side have their own paths.
      let route: CaptainRouteSetup | undefined;
      if (role === "captain") {
        try {
          route = await prepareCaptainRoute({
            backend,
            agentName,
            configuredPermissionMode: permissionMode,
            project: projectName ?? "",
            model,
            stateRoot,
            config,
            deps: {
              routerCredentials: (o) => fetchRouterCredentials(o.project, o.backend, { call: squadrantdCall }),
              writeRouterSettings,
            },
            warn: (m) => console.error(chalk.yellow(`  ⚠ ${m}`)),
          });
        } catch (err) {
          console.error(chalk.red(`  ✘ ${(err as Error).message}`));
          hadFailure = true;
          return;
        }
      }

      const priorRecord = projectName ? readCaptainAddress(stateRoot, projectName) : null;
      const captainPort = isOpencodeCaptain ? await getFreePort() : undefined;
      // #797: the resume id is decided inside agentCmdFactory, where the RESOLVED
      // forceFresh (CLI --fresh AND the auto-fresh new-day/template reasons) is
      // known. Captured here so the persistence callbacks below persist the same
      // id — without this the callbacks would have to re-derive forceFresh.
      let opencodeResumeSessionId: string | undefined;
      // #789: the launch instant bounds opencode session resolution — a session
      // created before this is NOT the captain's own (the repo root holds the
      // developer's sessions too), and it is persisted verbatim so the record
      // reports when the captain was launched, not when it was resolved.
      const launchedAt = new Date().toISOString();

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
              ensureSocksDir();
            }
            // #797: resume only when not fresh — `--fresh` must start a NEW
            // session, not reopen the one it replaced.
            const captainBoot = isOpencodeCaptain
              ? { port: captainPort, sessionId: pickResumeSessionId(priorRecord, "opencode", forceFresh) }
              : undefined;
            opencodeResumeSessionId = captainBoot?.sessionId;
            const baseCmd = buildAgentCmd(agentName, registry, role, forceFresh,
              route?.permissionMode ?? permissionMode,
              route?.model ?? model,
              TEMPLATES_DIR,
              resolveCaptainSocketPath(captainChannelEnabled, projectName, workspaceName),
              resolveCaptainSessionName(agentName, projectName),
              thinking,
              captainBoot,
              route?.settingsPath);
            // Routed ⇒ prepend the router env + SQUADRANT_GATE=on so the gate owns
            // PermissionRequest. Empty for native ⇒ command byte-for-byte unchanged.
            const gatePrefix = route && Object.keys(route.env).length > 0
              ? `${renderEnvAssignments(route.env)} `
              : "";
            const cmd = `${gatePrefix}${baseCmd}`;
            return captainOpencodeConfigPath
              ? `OPENCODE_CONFIG=${captainOpencodeConfigPath} ${cmd}`
              : cmd;
          },
          initialPrompt,
          runtime,
          navigate,
          pinToTop,
          classifyScreen: agentName === "opencode" ? classifyOpencodeStartupSurface : classifyStartupSurface,
          selectWorkspace: (id) => cmuxLocal(["select-workspace", "--workspace", id]),
          getCurrentWorkspace: () => {
            try {
              return cmuxLocal(["current-workspace"]);
            } catch { return null; }
          },
          onFreshReason: (reason) => console.log(chalk.cyan(`  ↻ ${reason}`)),
          onStoppingStale: (name) => console.log(chalk.yellow(`  Closing stale workspace '${name}' for fresh start`)),
          onAlreadyExists: (name) => {
            console.log(chalk.yellow(`  Workspace '${name}' already exists — switching to it`));
            if (!projectName || !isOpencodeCaptain) return;
            // #797: an existing workspace is NOT respawned, so the port we
            // allocated above was never bound. Refresh the record from the LIVE
            // server for this captain's directory (matched by its own session id
            // first) — otherwise a stale port survives the relaunch forever.
            const live = discoverLiveOpencodeServer({
              directory: realpathOrSelf(cwd),
              sessionId: priorRecord?.sessionId,
            });
            if (!live) return;
            const sessionId = live.sessionId ?? priorRecord?.sessionId;
            // Nothing changed ⇒ leave the record (and its original launchedAt) be.
            if (priorRecord && priorRecord.port === live.port && priorRecord.sessionId === sessionId) return;
            writeCaptainAddress(stateRoot, projectName, {
              agent: "opencode", port: live.port,
              ...(sessionId ? { sessionId } : {}),
              directory: realpathOrSelf(cwd), launchedAt,
            });
          },
          onCreated: (name) => {
            console.log(chalk.green(`  ✔ Workspace '${name}' created`));
            if (!projectName) return;
            if (isOpencodeCaptain && captainPort) {
              // #786/#789: the session does not exist until the startup prompt starts
              // a turn (spec §2 test 8), so on a COLD start this waits for it — and
              // only accepts a session CREATED at/after `launchedAt`, so a
              // pre-existing session in the directory is never mistaken for the
              // captain's (the silent misroute). Timeout ⇒ no record ⇒ the daemon
              // reports "not deliverable", never a silent no-box.
              // #797: on a RESUME the session id is already known, so it is
              // persisted immediately (the created-after gate must not reject it).
              void resolveAndPersistOpencodeCaptain({
                stateRoot, project: projectName, port: captainPort, directory: realpathOrSelf(cwd), launchedAt,
                sessionId: opencodeResumeSessionId,
              }).catch(() => {});
            } else if (role === "captain") {
              // Claude (and any other agent): mark the launch so the daemon knows
              // the captain was squadrant-launched.
              writeCaptainAddress(stateRoot, projectName, {
                agent: agentName, directory: realpathOrSelf(cwd), launchedAt,
              });
            }
          },
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
