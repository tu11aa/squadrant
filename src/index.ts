#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
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
import { addControlPlaneCrewCommands } from "./commands/crew-control.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { launchCommand } from "./commands/launch.js";
import { shutdownCommand } from "./commands/shutdown.js";
import { feedbackCommand } from "./commands/feedback.js";
import { reactorCommand } from "./commands/reactor.js";
import { standupCommand } from "./commands/standup.js";
import { retroCommand } from "./commands/retro.js";
import { runtimeCommand } from "./commands/runtime.js";
import { workspaceCommand } from "./commands/workspace.js";
import { trackerCommand } from "./commands/tracker.js";
import { notifyCommand } from "./commands/notify.js";
import { projectionCommand } from "./commands/projection.js";
import { codexChatSmokeCommand } from "./commands/codex-chat-smoke.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

// Self-heal the runtime copy of source-managed dirs before any command runs,
// so source changes (skills, role templates, scripts) can never silently
// drift from ~/.config/cockpit. Never throws.
ensureRuntimeSynced({
  sourceRoot: join(__dirname, ".."),
  runtimeRoot: join(homedir(), ".config", "cockpit"),
});

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
program.addCommand(commandCommand);
program.addCommand(dashboardCommand);
program.addCommand(launchCommand);
program.addCommand(shutdownCommand);
program.addCommand(feedbackCommand);
program.addCommand(reactorCommand);
program.addCommand(standupCommand);
program.addCommand(retroCommand);
program.addCommand(runtimeCommand);
program.addCommand(workspaceCommand);
program.addCommand(trackerCommand);
program.addCommand(notifyCommand);
program.addCommand(projectionCommand);
program.addCommand(codexChatSmokeCommand);

program.parseAsync().catch((e) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
