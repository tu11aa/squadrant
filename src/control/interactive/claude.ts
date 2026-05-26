import { execSync } from "node:child_process";
import type { InteractiveHookAdapter } from "./types.js";

const EVENTS = ["Stop", "SubagentStop", "SessionEnd"] as const;

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

export const claudeInteractive: InteractiveHookAdapter = {
  provider: "claude",
  tier: "strong",
  injectHook(launchSpec) {
    // Claude reads merged ~/.config settings; nothing to add to argv here.
    // The settings merge is performed by the launcher (Task 18) before spawn.
    return launchSpec;
  },
};
