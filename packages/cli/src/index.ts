#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ensureRuntimeSynced } from "@squadrant/shared";
import { ensureDaemon } from "@squadrant/core";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { projectsCommand } from "./commands/projects.js";
import { statusCommand } from "./commands/status.js";
import { commandCommand } from "./commands/command.js";
import { crewCommand } from "./commands/crew.js";
import { sideCommand } from "./commands/side.js";
import { addControlPlaneCrewCommands } from "./commands/crew-control.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { launchCommand } from "./commands/launch.js";
import { shutdownCommand } from "./commands/shutdown.js";
import { feedbackCommand } from "./commands/feedback.js";
import { standupCommand } from "./commands/standup.js";
import { retroCommand } from "./commands/retro.js";
import { runtimeCommand } from "./commands/runtime.js";
import { workspaceCommand } from "./commands/workspace.js";
import { notifyCommand } from "./commands/notify.js";
import { projectionCommand } from "./commands/projection.js";
import { codexChatSmokeCommand } from "./commands/codex-chat-smoke.js";
import { configCommand } from "./commands/config.js";
import { healCommand } from "./commands/heal.js";
import { groupCommand } from "./commands/group.js";
import { cmuxCommand } from "./commands/cmux.js";
import { effortCommand } from "./commands/effort.js";
import { telegramCommand } from "./commands/telegram.js";
import { detectDrift } from "@squadrant/shared";
import { needsCheck, withStamp } from "@squadrant/shared";
import { getDefaultConfig } from "@squadrant/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

// Self-heal the runtime copy of source-managed dirs before any command runs,
// so source changes (skills, role templates, scripts) can never silently
// drift from ~/.config/squadrant. Never throws.
ensureRuntimeSynced({
  sourceRoot: join(__dirname, ".."),
  runtimeRoot: join(homedir(), ".config", "squadrant"),
});

// Non-blocking config-drift banner. Suppressed during "squadrant config" —
// the config command already surfaces drift, making the banner redundant.
// Detect + print only — never mutates config and never throws.
if (process.argv[2] !== "config") {
  try {
    const cfgPath = join(homedir(), ".config", "squadrant", "config.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (needsCheck(cfg, pkg.version)) {
        const items = detectDrift(cfg, getDefaultConfig());
        if (items.length === 0) {
          writeFileSync(cfgPath, JSON.stringify(withStamp(cfg, pkg.version), null, 2) + "\n");
        } else {
          const from = cfg._squadrantVersion ?? "an earlier version";
          process.stderr.write(
            `\n\u26A1 squadrant updated ${from} \u2192 ${pkg.version} \u2014 ${items.length} config change(s) detected.\n` +
            `   Run \`squadrant config check\` (or use the config-doctor skill) to reconcile.\n\n`,
          );
        }
      }
    }
  } catch {
    // Drift banner is best-effort; never block the CLI.
  }
}

// Self-heal the control-plane daemon the same way we self-heal the runtime:
// best-effort, never throws; the CLI fails loud later if the socket is unreachable.
// ensureDaemon resolves its own entrypoint (see launchd.daemonEntryPath) — no
// path is passed here so no call site can get it wrong.
// SQUADRANT_DAEMON_SKIP short-circuits this for read-only / CI invocations that must
// not attempt to boot the daemon (e.g. config-check tests on Linux without launchctl).
if (!process.env.SQUADRANT_DAEMON_SKIP) {
  ensureDaemon();
}

const program = new Command();

program
  .name("squadrant")
  .description("Multi-project orchestration for your coding agents (Claude, Codex, opencode, Gemini)")
  .version(pkg.version);

program.addCommand(doctorCommand);
program.addCommand(initCommand);
program.addCommand(projectsCommand);
program.addCommand(statusCommand);
// Legacy crew verbs (spawn/send/read/close/list) stay intact for live captains;
// control-plane verbs (dispatch/status/tasks/reply) are attached onto the same
// `squadrant crew` command so PR #85 doesn't break the captain-ops playbook.
addControlPlaneCrewCommands(crewCommand);
program.addCommand(crewCommand);
program.addCommand(sideCommand);
program.addCommand(commandCommand);
program.addCommand(dashboardCommand);
program.addCommand(launchCommand);
program.addCommand(shutdownCommand);
program.addCommand(feedbackCommand);
program.addCommand(standupCommand);
program.addCommand(retroCommand);
program.addCommand(runtimeCommand);
program.addCommand(workspaceCommand);
program.addCommand(notifyCommand);
program.addCommand(projectionCommand);
program.addCommand(codexChatSmokeCommand);
program.addCommand(configCommand);
program.addCommand(healCommand);
program.addCommand(groupCommand);
program.addCommand(cmuxCommand);
program.addCommand(effortCommand);
program.addCommand(telegramCommand);

program.parseAsync().catch((e) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
