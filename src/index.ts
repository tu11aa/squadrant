#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { projectsCommand } from "./commands/projects.js";
import { statusCommand } from "./commands/status.js";
import { commandCommand } from "./commands/command.js";
import { crewCommand } from "./commands/crew.js";
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
import { crewSignalCommand } from "./commands/crew-signal.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();

program
  .name("cockpit")
  .description("Multi-project agent orchestration for Claude Code")
  .version(pkg.version);

program.addCommand(doctorCommand);
program.addCommand(initCommand);
program.addCommand(projectsCommand);
program.addCommand(statusCommand);
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
program.addCommand(crewSignalCommand);

program.parse();
