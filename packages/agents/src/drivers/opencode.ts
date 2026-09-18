import { execSync } from "node:child_process";
import type { AgentDriver, AgentProbeResult, AgentSession, SpawnOptions, AgentResult } from "./types.js";
import { listOpencodeSessions } from "../sessions/opencode-sessions.js";

export function createOpencodeDriver(): AgentDriver {
  return {
    name: "opencode",
    templateSuffix: "opencode",

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
      // Interactive crews: boot the TUI; the caller delivers opts.prompt as the
      // first turn via runtime.send once the session is ready, so the crew stays
      // alive for follow-up turns through `squadrant crew send`. When a port is
      // given, bind the embedded HTTP server on it so the daemon's SSE bridge
      // can subscribe to /event for turn-end detection (the bare TUI uses an
      // ephemeral unix socket with no reachable /event endpoint).
      // #786: resume is always explicit (--session), never -c (spec §2 test 9).
      if (opts.interactive) {
        let cmd = "opencode";
        if (opts.sessionId) cmd += ` --session ${opts.sessionId}`;
        if (opts.port) cmd += ` --port ${opts.port}`;
        return cmd;
      }
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

    // #669: captain-record-backed session introspection (read-only).
    async listSessions(): Promise<AgentSession[]> {
      return listOpencodeSessions();
    },
  };
}
