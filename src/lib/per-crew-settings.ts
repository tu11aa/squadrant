import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeClaudeHooks } from "../control/interactive/claude.js";

/**
 * Starter Bash permission allowlist for crews running under
 * `--permission-mode acceptEdits` (Phase 2a). acceptEdits auto-accepts file
 * edits but still prompts on EVERY mutating shell command — including routine
 * dev ops (commit, push, install, test). Without this, the Phase 2b pane probe
 * would fire CREW BLOCKED on every commit/install/test = notification spam.
 *
 * Conservative by design: only safe-but-mutating *dev* commands are listed,
 * scoped per-subcommand so genuinely risky ops (`git reset --hard`,
 * `git config`, `rm`, `curl`, `wget`, unknown binaries, out-of-workspace
 * writes) STILL prompt and surface as CREW BLOCKED. No blanket `Bash(*)`.
 *
 * Syntax: Claude Code Bash permission patterns, `Bash(<prefix>:*)` matches the
 * prefix command plus any trailing args.
 */
export const CREW_PERMISSION_ALLOWLIST: readonly string[] = [
  // git — read + safe mutations (reset/clean/config intentionally excluded)
  "Bash(git status:*)",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git push:*)",
  "Bash(git pull:*)",
  "Bash(git fetch:*)",
  "Bash(git checkout:*)",
  "Bash(git branch:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git stash:*)",
  "Bash(git restore:*)",
  // npm / npx — installs + script/test/build runners
  "Bash(npm install:*)",
  "Bash(npm ci:*)",
  "Bash(npm run:*)",
  "Bash(npm test:*)",
  "Bash(npx vitest:*)",
  "Bash(npx tsc:*)",
  // direct runners
  "Bash(node:*)",
  "Bash(vitest:*)",
  "Bash(tsc:*)",
];

/**
 * Pure: merge the crew permission allowlist into a settings object's
 * `permissions.allow`, de-duplicating and preserving any existing entries and
 * sibling permission keys (deny/ask). Never mutates the input.
 */
export function mergeCrewPermissions(settings: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(settings ?? {});
  const permissions = (next.permissions ??= {}) as { allow?: unknown };
  const existing = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];
  permissions.allow = [...new Set([...existing, ...CREW_PERMISSION_ALLOWLIST])];
  return next;
}

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
 * Write cockpit hooks into `<projectCwd>/.claude/settings.local.json` so they
 * are auto-loaded by Claude Code as a project-local settings source (level 3
 * in the precedence hierarchy). Unlike the per-crew settings.json passed via
 * `--settings` (level 2), this auto-loaded file merges with the cmux wrapper's
 * `--settings` hooks rather than being overwritten by them (#134).
 *
 * Merges with any existing `.claude/settings.local.json` — does not clobber
 * the user's own personal hooks or permissions. Returns the absolute path.
 */
export function writePerCrewSettingsLocal(o: {
  projectCwd: string;
  hookCmd?: string;
}): string {
  const dir = join(o.projectCwd, ".claude");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.local.json");
  let existing: Record<string, unknown> = {};
  try {
    const raw = readFileSync(file, "utf-8");
    existing = JSON.parse(raw);
  } catch {
    // File doesn't exist or isn't valid JSON — start fresh
  }
  const withHooks = mergeClaudeHooks(existing, o.hookCmd ?? "cockpit crew _hook");
  const merged = mergeCrewPermissions(withHooks);
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
