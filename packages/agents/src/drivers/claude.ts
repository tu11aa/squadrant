import { execSync } from "node:child_process";
import type { AgentDriver, AgentProbeResult, SpawnOptions, AgentResult } from "./types.js";

export function createClaudeDriver(): AgentDriver {
  return {
    name: "claude",
    templateSuffix: "claude",

    async probe(): Promise<AgentProbeResult> {
      try {
        const version = execSync("claude --version", { encoding: "utf-8" }).trim();
        return {
          installed: true,
          version,
          capabilities: [
            "teams",
            "json_output",
            "model_routing",
            "skills",
            "auto_approve",
            "streaming",
            "prompt_file",
          ],
        };
      } catch {
        return { installed: false, version: "", capabilities: [] };
      }
    },

    buildCommand(opts: SpawnOptions): string {
      let cmd = "claude";

      if (opts.sessionName) {
        cmd += ` -n ${opts.sessionName}`;
      }

      if (opts.model) {
        cmd += ` --model ${opts.model}`;
      }

      if (opts.thinking) {
        cmd += ` --effort ${opts.thinking}`;
      }

      if (opts.autoApprove) {
        cmd += " --dangerously-skip-permissions";
      } else if (opts.permissionMode) {
        cmd += ` --permission-mode ${opts.permissionMode}`;
      }

      if (opts.promptFile) {
        cmd += ` --append-system-prompt-file ${opts.promptFile}`;
      }

      if (opts.settingsPath) {
        cmd += ` --settings ${opts.settingsPath}`;
      }

      // Load squadrant plugin for skills. Crews get a subset plugin dir
      // (crew.generic.md/crew.claude.md only ever reference karpathy-principles)
      // synced by ensureRuntimeSynced — the harness lists only skills that
      // role actually needs, instead of all 16 squadrant ships.
      const pluginSubdir = opts.role === "crew" ? "plugin-crew" : "plugin";
      const pluginDir = `${process.env.HOME}/.config/squadrant/${pluginSubdir}`;
      cmd += ` --plugin-dir ${pluginDir}`;

      // #697/#759: must come AFTER --plugin-dir (and be the last flag for
      // interactive sessions) — cmux <=0.64.18 truncates launchCommand.arguments
      // at --messaging-socket-path when storing it, so anything after it
      // (including --plugin-dir) is lost and role classification breaks.
      // Match the captain/command path (launch-cmd.ts).
      if (opts.messagingSocketPath) {
        cmd += ` --messaging-socket-path ${opts.messagingSocketPath}`;
      }

      if (!opts.interactive) {
        cmd += ` -p "${opts.prompt.replace(/"/g, '\\"')}"`;
      }
      return cmd;
    },

    parseOutput(raw: string): AgentResult {
      const lines = raw.trim().split("\n").filter((l) => l.startsWith("{"));
      if (lines.length === 0) {
        return { status: "success", output: raw.trim() };
      }
      try {
        const last = JSON.parse(lines[lines.length - 1]);
        return { status: "success", output: last.result || last.content || raw.trim() };
      } catch {
        return { status: "success", output: raw.trim() };
      }
    },

    async stop(pid: number): Promise<void> {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // process may already be gone
      }
    },
  };
}
