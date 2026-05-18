// src/control/headless/claude.ts
import type { HeadlessAdapter } from "./types.js";
import { HEADLESS_ERROR_TAIL } from "./types.js";

export const claudeHeadless: HeadlessAdapter = {
  provider: "claude",
  buildCommand(task, sessionId) {
    const argv = ["claude", "-p", "--output-format", "json"];
    if (sessionId) argv.push("--resume", sessionId);
    argv.push(task);
    return argv;
  },
  parseResult(stdout, exitCode) {
    if (exitCode !== 0) {
      return { outcome: "failed", exitCode, error: stdout.slice(-HEADLESS_ERROR_TAIL) };
    }
    try {
      const j = JSON.parse(stdout);
      if (j.is_error) return { outcome: "failed", error: String(j.result ?? "is_error"), sessionId: j.session_id };
      const payload = typeof j.result === "string" ? j.result : j.result == null ? "" : JSON.stringify(j.result);
      return { outcome: "done", sessionId: j.session_id, payload };
    } catch {
      return { outcome: "done", parseWarning: true, payload: stdout };
    }
  },
};
