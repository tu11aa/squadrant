// src/control/headless/codex.ts
import type { HeadlessAdapter } from "./types.js";
import { HEADLESS_ERROR_TAIL } from "./types.js";

export const codexHeadless: HeadlessAdapter = {
  provider: "codex",
  buildCommand(task, sessionId) {
    // Verified against codex-cli 0.130.0 `codex exec [OPTIONS] [PROMPT]`:
    //  --json: JSONL events to stdout (valid).
    //  --skip-git-repo-check: REQUIRED — the daemon spawns codex with a
    //    non-trusted/non-git cwd under launchd; without it codex aborts with
    //    "Not inside a trusted directory and --skip-git-repo-check was not
    //    specified." (real production failure, red-team/verify-on-implement).
    //  resume is a SUBCOMMAND (`codex exec resume <id>`), NOT a `--session`
    //    flag. Resume is unused in foundational scope (multi-turn/reply
    //    deferred) — kept best-effort; flag order is verify-on-implement when
    //    the interactive-wiring spec lands.
    // --sandbox workspace-write: codex exec defaults to a READ-ONLY sandbox,
    // so a crew could analyze/spec but never edit code (real prod finding:
    // codex bailed "workspace is mounted read-only"). workspace-write lets it
    // edit within its cwd (set by the launcher per-task) — NOT full-disk
    // (danger-full-access) which would be reckless for an autonomous agent.
    const opts = ["--json", "--skip-git-repo-check", "--sandbox", "workspace-write"];
    if (sessionId) return ["codex", "exec", "resume", sessionId, ...opts, task];
    return ["codex", "exec", ...opts, task];
  },
  parseResult(stdout, exitCode) {
    if (exitCode !== 0) return { outcome: "failed", exitCode, error: stdout.slice(-HEADLESS_ERROR_TAIL) };
    // codex result format undocumented; keep raw, never guess failure.
    return { outcome: "done", payload: stdout };
  },
};
