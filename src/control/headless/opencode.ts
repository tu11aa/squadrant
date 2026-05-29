// src/control/headless/opencode.ts
import type { HeadlessAdapter } from "./types.js";
import { HEADLESS_ERROR_TAIL } from "./types.js";

// opencode `run` is used for one-shot; serve-session wiring is a later spec.
// Process-exit is the done-signal here (foundational scope).
export const opencodeHeadless: HeadlessAdapter = {
  provider: "opencode",
  buildCommand(task, sessionId) {
    const argv = ["opencode", "run", "--format", "json"];
    if (sessionId) argv.push("--session", sessionId);
    argv.push(task);
    return argv;
  },
  parseResult(stdout, exitCode) {
    if (exitCode !== 0) return { outcome: "failed", exitCode, error: stdout.slice(-HEADLESS_ERROR_TAIL) };
    try {
      const j = JSON.parse(stdout);
      const payload = typeof j.result === "string" ? j.result : JSON.stringify(j.result ?? stdout);
      return { outcome: "done", sessionId: j.sessionID ?? j.session_id, payload };
    } catch {
      return { outcome: "done", parseWarning: true, payload: stdout };
    }
  },
};
