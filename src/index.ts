#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ensureRuntimeSynced } from "./lib/runtime-sync.js";
import { ensureDaemon } from "./control/launchd.js";
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
import { notifyRelayCommand } from "./commands/notify-relay.js";
import { relayCommand } from "./commands/relay.js";
import { projectionCommand } from "./commands/projection.js";
import { codexChatSmokeCommand } from "./commands/codex-chat-smoke.js";
import { configCommand } from "./commands/config.js";
import { healCommand } from "./commands/heal.js";
import { groupCommand } from "./commands/group.js";
import { detectDrift } from "./lib/config-drift.js";
import { needsCheck, withStamp } from "./lib/config-version.js";
import { getDefaultConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

// Self-heal the runtime copy of source-managed dirs before any command runs,
// so source changes (skills, role templates, scripts) can never silently
// drift from ~/.config/cockpit. Never throws.
ensureRuntimeSynced({
  sourceRoot: join(__dirname, ".."),
  runtimeRoot: join(homedir(), ".config", "cockpit"),
});

// Non-blocking config-drift banner. Suppressed during "cockpit config" —
// the config command already surfaces drift, making the banner redundant.
// Detect + print only — never mutates config and never throws.
if (process.argv[2] !== "config") {
  try {
    const cfgPath = join(homedir(), ".config", "cockpit", "config.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (needsCheck(cfg, pkg.version)) {
        const items = detectDrift(cfg, getDefaultConfig());
        if (items.length === 0) {
          writeFileSync(cfgPath, JSON.stringify(withStamp(cfg, pkg.version), null, 2) + "\n");
        } else {
          const from = cfg._cockpitVersion ?? "an earlier version";
          process.stderr.write(
            `\n\u26A1 cockpit updated ${from} \u2192 ${pkg.version} \u2014 ${items.length} config change(s) detected.\n` +
            `   Run \`cockpit config check\` (or use the config-doctor skill) to reconcile.\n\n`,
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
ensureDaemon();

const program = new Command();

program
  .name("cockpit")
  .description("Multi-project agent orchestration for Claude Code")
  .version(pkg.version);

program.addCommand(doctorCommand);
program.addCommand(initCommand);
program.addCommand(projectsCommand);
program.addCommand(statusCommand);
// Legacy crew verbs (spawn/send/read/close/list) stay intact for live captains;
// control-plane verbs (dispatch/status/tasks/reply) are attached onto the same
// `cockpit crew` command so PR #85 doesn't break the captain-ops playbook.
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
program.addCommand(notifyRelayCommand);
program.addCommand(relayCommand);
program.addCommand(projectionCommand);
program.addCommand(codexChatSmokeCommand);
program.addCommand(configCommand);
program.addCommand(healCommand);
program.addCommand(groupCommand);

program.parseAsync().catch((e) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
