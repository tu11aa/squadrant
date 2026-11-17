// packages/cli/src/lib/claude-trust.ts
//
// Edits to the `projects` map of `~/.claude.json` that make Claude Code skip its folder-trust dialog:
// the dev captain's project (#1090) and the per-task crew brief folder (#1138).
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { stateRoot } from "@squadrant/shared";

/**
 * Pre-trusts `paths` in `~/.claude.json` (`projects[<path>].hasTrustDialogAccepted: true` — the documented
 * key Claude Code's own error text points at), so the dev captain never opens on the folder-trust dialog.
 * Claude keys trust by the resolved path (/private/var/… on macOS) and walks up from cwd, so callers pass
 * both spellings. The file is shared and rewritten by every running Claude Code session, so this is a
 * single read-modify-write of just these keys (atomic rename), re-checked after the write. Returns how many
 * entries it added or flipped; `dev down` prunes them with `pruneClaudeProjects`.
 */
export function ensureClaudeTrust(paths: string[], claudeJson: string = join(homedir(), ".claude.json")): number {
  const want = [...new Set(paths)];
  let added = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    let data: { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
    try { data = JSON.parse(readFileSync(claudeJson, "utf8")); } catch { return added; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return added;
    if (data.projects !== undefined && (typeof data.projects !== "object" || data.projects === null || Array.isArray(data.projects))) return added;
    const projects = (data.projects ??= {});
    const missing = want.filter((k) => projects[k]?.hasTrustDialogAccepted !== true);
    if (missing.length === 0) return added;
    for (const k of missing) projects[k] = { ...(typeof projects[k] === "object" ? projects[k] : {}), hasTrustDialogAccepted: true };
    const target = realpathSync(claudeJson); // keep a symlinked ~/.claude.json a symlink
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: statSync(target).mode & 0o777 });
    renameSync(tmp, target);
    added = Math.max(added, missing.length);
  }
  return added;
}

/** Both spellings of `dir` (it must exist) — see ensureClaudeTrust. */
export function trustSpellings(dir: string): string[] {
  return [...new Set([dir, realpathSync(dir)])];
}

/** Drops the `projects` entries of `~/.claude.json` that live under `roots` (the trust `up` seeded, plus anything Claude recorded for the dev project). Every other key is left alone; the file is rewritten atomically, and only when something changed. */
export function pruneClaudeProjects(roots: string[], claudeJson: string = join(homedir(), ".claude.json")): number {
  let data: { projects?: Record<string, unknown> };
  try { data = JSON.parse(readFileSync(claudeJson, "utf8")); } catch { return 0; }
  const projects = data?.projects;
  if (!projects || typeof projects !== "object") return 0;
  const under = (k: string) => roots.some((r) => k === r || k.startsWith(r + sep));
  const drop = Object.keys(projects).filter(under);
  if (drop.length === 0) return 0;
  for (const k of drop) delete projects[k];
  const tmp = `${claudeJson}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: statSync(claudeJson).mode & 0o777 });
  renameSync(tmp, claudeJson);
  return drop.length;
}

/**
 * #1138: Claude Code asks "Is this a directory you created or one you trust?" for every `--add-dir` folder it has not
 * seen, and a crew's brief folder (`<stateRoot>/<project>/<taskId>/brief`) is new per task. Trust is inherited from a
 * parent, so trusting squadrant's own state root once covers every brief folder under it.
 */
export function ensureStateRootTrust(claudeJson: string = join(homedir(), ".claude.json")): number {
  const root = stateRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return ensureClaudeTrust(trustSpellings(root), claudeJson);
}
