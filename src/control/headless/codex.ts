// src/control/headless/codex.ts
import type { HeadlessAdapter } from "./types.js";
import { HEADLESS_ERROR_TAIL } from "./types.js";

export const codexHeadless: HeadlessAdapter = {
  provider: "codex",
  buildCommand(task, sessionId) {
    const argv = ["codex", "exec", "--json"];
    if (sessionId) argv.push("--session", sessionId);
    argv.push(task);
    return argv;
  },
  parseResult(stdout, exitCode) {
    if (exitCode !== 0) return { outcome: "failed", exitCode, error: stdout.slice(-HEADLESS_ERROR_TAIL) };
    // codex result format undocumented; keep raw, never guess failure.
    return { outcome: "done", payload: stdout };
  },
};
