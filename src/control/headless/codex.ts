// src/control/headless/codex.ts
import type { HeadlessAdapter } from "./types.js";

export const codexHeadless: HeadlessAdapter = {
  provider: "codex",
  buildCommand(task, sessionId) {
    const argv = ["codex", "exec", "--json"];
    if (sessionId) argv.push("--session", sessionId);
    argv.push(task);
    return argv;
  },
  parseResult(stdout, exitCode) {
    if (exitCode !== 0) return { outcome: "failed", exitCode, error: stdout.slice(-2000) };
    // codex result payload format is less documented: keep raw, never guess failure.
    try { JSON.parse(stdout.trim().split("\n").pop() ?? ""); } catch { /* tolerated */ }
    return { outcome: "done", payload: stdout };
  },
};
