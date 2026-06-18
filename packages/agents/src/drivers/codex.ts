import { execSync } from "node:child_process";
import type { AgentDriver, AgentProbeResult, SpawnOptions, AgentResult } from "./types.js";

export function createCodexDriver(): AgentDriver {
  return {
    name: "codex",
    templateSuffix: "generic",

    async probe(): Promise<AgentProbeResult> {
      try {
        const version = execSync("codex --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        const help = execSync("codex --help", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        const hasExec = help.includes("exec");
        return {
          installed: true,
          version,
          capabilities: [
            "auto_approve",
            "json_output",
            "sandbox",
            ...(hasExec ? ["streaming" as const] : []),
          ],
        };
      } catch {
        return { installed: false, version: "", capabilities: [] };
      }
    },

    buildCommand(opts: SpawnOptions): string {
      let cmd = `codex exec "${opts.prompt.replace(/"/g, '\\"')}" --json`;
      if (opts.autoApprove) cmd += " --full-auto";
      return cmd;
    },

    parseOutput(raw: string): AgentResult {
      const lines = raw.trim().split("\n").filter((l) => l.startsWith("{"));
      if (lines.length === 0) {
        return { status: "success", output: raw.trim() };
      }
      try {
        const last = JSON.parse(lines[lines.length - 1]);
        return { status: "success", output: last.output || last.result || raw.trim() };
      } catch {
        return { status: "success", output: raw.trim() };
      }
    },

    async stop(pid: number): Promise<void> {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    },
  };
}
