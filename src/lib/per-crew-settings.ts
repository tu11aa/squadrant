import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeClaudeHooks } from "../control/interactive/claude.js";

/**
 * Write a Claude `--settings`-compatible JSON file containing the cockpit
 * Stop/SubagentStop/SessionEnd hooks merged onto an empty base. Per-crew
 * scoping (one file per spawned task) keeps the hook out of the user's
 * global `~/.claude/settings.json` — captain/command Claude sessions are
 * untouched. Returns the absolute path to the written file.
 */
export function writePerCrewSettings(o: {
  stateRoot: string;
  project: string;
  taskId: string;
  hookCmd?: string;
}): string {
  const dir = join(o.stateRoot, o.project, o.taskId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  const merged = mergeClaudeHooks({}, o.hookCmd ?? "cockpit crew _hook");
  writeFileSync(file, JSON.stringify(merged, null, 2));
  return file;
}

/**
 * Write an opencode config file that auto-approves edit/bash/webfetch so
 * cockpit-spawned opencode crews never block on a manual permission prompt.
 * OPENCODE_CONFIG merges with (does not replace) the global config, so only
 * the permission block is needed — model/plugin/mcp flow through from
 * ~/.config/opencode/opencode.json automatically.
 *
 * Returns the absolute path to the written file.
 */
export function writePerCrewOpencodeConfig(o: {
  stateRoot: string;
  project: string;
  taskId: string;
}): string {
  const dir = join(o.stateRoot, o.project, o.taskId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "opencode.json");
  const config = {
    permission: {
      read: "allow",
      edit: "allow",
      glob: "allow",
      grep: "allow",
      bash: "allow",
      webfetch: "allow",
      websearch: "allow",
      task: "allow",
      lsp: "allow",
      external_directory: { "**": "allow" },
    },
  };
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}
