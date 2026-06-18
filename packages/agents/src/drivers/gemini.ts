import { execSync } from "node:child_process";
import type { AgentDriver, AgentProbeResult, SpawnOptions, AgentResult } from "./types.js";

export function createGeminiDriver(): AgentDriver {
  return {
    name: "gemini",
    templateSuffix: "generic",

    async probe(): Promise<AgentProbeResult> {
      try {
        const version = execSync("gemini --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        return {
          installed: true,
          version,
          capabilities: ["auto_approve", "json_output", "streaming"],
        };
      } catch {
        return { installed: false, version: "", capabilities: [] };
      }
    },

    buildCommand(opts: SpawnOptions): string {
      let cmd = `gemini -p "${opts.prompt.replace(/"/g, '\\"')}"`;
      if (opts.autoApprove) cmd += " --yolo";
      if (opts.jsonOutput) cmd += " --output-format json";
      return cmd;
    },

    parseOutput(raw: string): AgentResult {
      try {
        const parsed = JSON.parse(raw.trim());
        return { status: "success", output: parsed.response || raw.trim() };
      } catch {
        return { status: "success", output: raw.trim() };
      }
    },

    async stop(pid: number): Promise<void> {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    },
  };
}
