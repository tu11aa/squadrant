import { execSync } from "node:child_process";
import type { AgentDriver, AgentProbeResult, SpawnOptions, AgentResult } from "./types.js";

export function createOpencodeDriver(): AgentDriver {
  return {
    name: "opencode",
    templateSuffix: "generic",

    async probe(): Promise<AgentProbeResult> {
      try {
        const version = execSync("opencode --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        return {
          installed: true,
          version,
          capabilities: ["auto_approve", "json_output", "streaming", "model_routing"],
        };
      } catch {
        return { installed: false, version: "", capabilities: [] };
      }
    },

    buildCommand(opts: SpawnOptions): string {
      // Interactive crews: boot the TUI bare; the caller delivers opts.prompt
      // as the first turn via runtime.send once the session is ready, so the
      // crew stays alive for follow-up turns through `cockpit crew send`.
      if (opts.interactive) return "opencode";
      let cmd = `opencode run "${opts.prompt.replace(/"/g, '\\"')}"`;
      if (opts.jsonOutput) cmd += " --format json";
      if (opts.model) cmd += ` -m ${opts.model}`;
      return cmd;
    },

    parseOutput(raw: string): AgentResult {
      try {
        const parsed = JSON.parse(raw.trim());
        return { status: "success", output: parsed.response || parsed.output || raw.trim() };
      } catch {
        return { status: "success", output: raw.trim() };
      }
    },

    async stop(pid: number): Promise<void> {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    },
  };
}
