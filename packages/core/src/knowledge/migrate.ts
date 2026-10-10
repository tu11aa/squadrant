// packages/core/src/knowledge/migrate.ts — one-shot move of <hubVault>/knowledge/<kb>/ to the KB root (#936).
// Never deletes: same-device it is a rename; cross-device it copies and leaves the original in place.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { KB_NAME_RE, resolveHome, type SquadrantConfig } from "@squadrant/shared";
import { kbDir, legacyKbDir } from "./paths.js";

export interface KbMoveEntry {
  kb: string; from: string; to: string;
  action: "moved" | "copied" | "skipped" | "would-move";
  note?: string;
}

const legacyRoot = (cfg: SquadrantConfig) => path.join(resolveHome(cfg.hubVault), "knowledge");

/** KB names present in the old hub-vault location. */
export function findLegacyKbs(cfg: SquadrantConfig): string[] {
  const root = legacyRoot(cfg);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && KB_NAME_RE.test(e.name))
    .map((e) => e.name).sort();
}

/** `git init` if the dir is not a repo yet (remote optional). Returns whether it ran. */
export function ensureGitRepo(dir: string): boolean {
  if (fs.existsSync(path.join(dir, ".git"))) return false;
  try { execFileSync("git", ["init", "-q", dir], { stdio: "ignore" }); return true; } catch { return false; }
}

export function moveLegacyKbs(cfg: SquadrantConfig, opts: { dryRun?: boolean } = {}): KbMoveEntry[] {
  const hub = resolveHome(cfg.hubVault);
  return findLegacyKbs(cfg).map((kb): KbMoveEntry => {
    const from = legacyKbDir(hub, kb);
    const to = kbDir(cfg, kb);
    if (fs.existsSync(to)) return { kb, from, to, action: "skipped", note: "target already exists; nothing moved" };
    if (opts.dryRun) return { kb, from, to, action: "would-move" };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    let action: KbMoveEntry["action"] = "moved";
    try {
      fs.renameSync(from, to);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      fs.cpSync(from, to, { recursive: true });
      action = "copied";
    }
    const notes: string[] = [];
    // Old layout kept rules at <kb>/rules; the final layout is <kb>/shared/rules.
    const oldRules = path.join(to, "rules"), newRules = path.join(to, "shared", "rules");
    if (fs.existsSync(oldRules) && !fs.existsSync(newRules)) {
      fs.mkdirSync(path.dirname(newRules), { recursive: true });
      fs.renameSync(oldRules, newRules);
      notes.push("rules/ -> shared/rules/");
    }
    if (ensureGitRepo(to)) notes.push("git init");
    if (fs.existsSync(path.join(to, "index.json"))) notes.push(`index.json holds old paths: run squadrant knowledge reindex ${kb}`);
    if (action === "copied") notes.push("cross-device: original left in place, delete it yourself once verified");
    return { kb, from, to, action, ...(notes.length ? { note: notes.join("; ") } : {}) };
  });
}
