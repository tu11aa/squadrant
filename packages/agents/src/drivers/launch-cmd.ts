// buildAgentCmd — build the CLI command string used to launch a captain/command
// session. Extracted from packages/cli/src/commands/launch.ts so it can be
// unit-tested without spawning real processes.

import fs from "node:fs";
import path from "node:path";
import type { Role } from "./types.js";
import type { CapabilityRegistry } from "./registry.js";

/**
 * Build the shell command string that launches an agent session for a given
 * role. For Claude, handles fresh/continue, permission-mode flags, role
 * template file, and plugin-dir. For all other agents, delegates to the
 * driver's own buildCommand.
 *
 * @param agentName     - e.g. "claude", "opencode", "codex"
 * @param registry      - populated CapabilityRegistry
 * @param role          - "captain" | "command" | "crew" | …
 * @param fresh         - true → new session; false → continue last session
 * @param permissionMode - "acceptEdits" | "auto" | "bypassPermissions"
 * @param model         - optional model override
 * @param templatesDir  - resolved path to ~/.config/squadrant/templates
 */
export function buildAgentCmd(
  agentName: string,
  registry: CapabilityRegistry,
  role: string,
  fresh: boolean,
  permissionMode: string,
  model?: string,
  templatesDir?: string,
): string {
  const driver = registry.getDriver(agentName);

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

    if (templatesDir) {
      const roleFile = path.join(templatesDir, `${role}.claude.md`);
      const legacyRoleFile = path.join(templatesDir, `${role}.CLAUDE.md`);
      const actualRoleFile = fs.existsSync(roleFile)
        ? roleFile
        : fs.existsSync(legacyRoleFile) ? legacyRoleFile : null;
      if (actualRoleFile) {
        cmd += ` --append-system-prompt-file ${actualRoleFile}`;
      }

      const pluginDir = path.join(templatesDir, "..", "plugin");
      if (fs.existsSync(pluginDir)) {
        cmd += ` --plugin-dir ${pluginDir}`;
      }
    }

    return cmd;
  }

  // Non-Claude agents: delegate to driver.buildCommand.
  const roleFile = templatesDir
    ? path.join(templatesDir, `${role}.${driver.templateSuffix}.md`)
    : undefined;
  return driver.buildCommand({
    prompt: `You are a cockpit ${role}. Read your instructions from ${roleFile ?? role} and begin.`,
    workdir: process.cwd(),
    role: role as Role,
    model,
    autoApprove: true,
    promptFile: roleFile && fs.existsSync(roleFile) ? roleFile : undefined,
  });
}
