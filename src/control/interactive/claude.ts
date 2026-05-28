import { execSync } from "node:child_process";
import type { InteractiveHookAdapter } from "./types.js";
import type { ControlEvent } from "../types.js";

// PostToolUse fires after EVERY tool call mid-turn — it is the only liveness
// signal that refreshes the heartbeat while a crew is still working. Stop/
// SubagentStop/SessionEnd fire only at turn boundaries, so a long working turn
// would otherwise exceed heartbeatBudgetMs and trip a false CREW STALLED alert.
const EVENTS = ["Stop", "SubagentStop", "SessionEnd", "PostToolUse"] as const;

/**
 * Probe whether the local Claude CLI supports `--settings <path>`. The
 * daemon-supervised crew path needs per-invocation settings to inject the
 * cockpit Stop hook without polluting the user's global `~/.claude/settings.json`
 * (the scrapped PR #71 mistake). Returns "flag" when --settings is available
 * (the happy path), "project-dir" when the fallback (write `.claude/settings.json`
 * under the project dir + cd) is needed.
 */
export function probeClaudeSettingsFlag(): "flag" | "project-dir" {
  try {
    const help = execSync("claude --help", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return help.includes("--settings ") ? "flag" : "project-dir";
  } catch {
    return "project-dir";
  }
}

/** Pure, idempotent merge of cockpit hooks into a Claude settings object. */
export function mergeClaudeHooks(settings: any, hookCmd: string): any {
  const next = structuredClone(settings ?? {});
  next.hooks ??= {};
  for (const ev of EVENTS) {
    if (!Array.isArray(next.hooks[ev])) next.hooks[ev] = [];
    const already = next.hooks[ev].some((m: any) =>
      Array.isArray(m?.hooks) && m.hooks.some((h: any) => typeof h.command === "string" && h.command.includes(hookCmd)),
    );
    if (!already) {
      next.hooks[ev].push({ matcher: "", hooks: [{ type: "command", command: `${hookCmd} ${ev}`, timeout: 10 }] });
    }
  }
  return next;
}

/**
 * Map a Claude hook event name to a cockpit ControlEvent. Pure function —
 * isolated for testability and to codify the anti-#2576 invariant in one
 * place: NO Claude hook ever maps to `task.done`/`task.failed`/`task.blocked`.
 * Stop/SubagentStop/SessionEnd/PostToolUse = liveness only. Terminal state
 * comes exclusively from explicit `cockpit crew signal` (Task 4).
 * PostToolUse is the mid-turn heartbeat (fires per tool call); the others are
 * turn-boundary liveness.
 */
export function mapClaudeHookToEvent(
  event: string,
  _payload: unknown,
  taskId: string,
): ControlEvent | null {
  switch (event) {
    case "Stop":
    case "SubagentStop":
    case "SessionEnd":
    case "PostToolUse":
      return { type: "task.progress", id: taskId, note: event.toLowerCase() };
    default:
      return null;
  }
}

export const claudeInteractive: InteractiveHookAdapter = {
  provider: "claude",
  tier: "strong",
  injectHook(launchSpec) {
    // Claude reads merged ~/.config settings; nothing to add to argv here.
    // The settings merge is performed by the launcher (Task 18) before spawn.
    return launchSpec;
  },
};
