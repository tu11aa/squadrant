import { execSync } from "node:child_process";
import type { InteractiveHookAdapter } from "./types.js";
import type { ControlEvent } from "../types.js";

// PostToolUse fires after EVERY tool call mid-turn — it is the only liveness
// signal that refreshes the heartbeat while a crew is still working.
// Stop fires at turn completion and maps to task.turn.completed so the task
// transitions to awaiting-input (immune to stall detection) — without this,
// a captain AFK for >heartbeatBudgetMs would get a false CREW STALLED.
// SubagentStop/SessionEnd fire only at turn boundaries but are liveness-only:
// SubagentStop fires while the parent agent still owns the turn, and SessionEnd
// is an unreliable signal (crash / Ctrl-C / /exit).
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
 * PostToolUse/SubagentStop/SessionEnd = liveness only (task.progress).
 * Stop = turn boundary (task.turn.completed → awaiting-input, stall-immune).
 * Terminal state comes exclusively from explicit `cockpit crew signal`.
 *
 * Stop is remapped to task.turn.completed so the task leaves the working
 * state between turns — no hooks fire while the captain reviews output,
 * so the previous liveness-only mapping would heartbeat-expire after
 * heartbeatBudgetMs and fire a false CREW STALLED alert. The awaiting-input
 * state is immune to evaluateStall (fixes #131).
 */
export function mapClaudeHookToEvent(
  event: string,
  _payload: unknown,
  taskId: string,
): ControlEvent | null {
  switch (event) {
    case "Stop":
      return { type: "task.turn.completed", id: taskId, turnId: "hook-stop" };
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
