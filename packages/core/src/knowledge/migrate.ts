// packages/core/src/knowledge/migrate.ts — one-shot move of <hubVault>/knowledge/<kb>/ to the KB root (#936).
// Never deletes: same-device it is a rename; cross-device it copies and leaves the original in place.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { KB_NAME_RE, projectRulesHome, resolveHome, type SquadrantConfig } from "@squadrant/shared";
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

/** Runtime reconcile state written to the KB root: derived or per-machine, never committed (#1002). */
export const KB_RUNTIME_IGNORES = ["/scores.json", "/escalations.json"];

const KB_GITIGNORE = "# squadrant KB defaults: source documents stay local\nraw/\n.converted/\n"
  + `# reconcile runtime state\n${KB_RUNTIME_IGNORES.join("\n")}\n`;

/** Write the default .gitignore if the KB has none (#951). Never touches an existing one. Returns whether it wrote. */
export function ensureKbGitignore(dir: string): boolean {
  const file = path.join(dir, ".gitignore");
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, KB_GITIGNORE);
  return true;
}

/** Append any missing KB_RUNTIME_IGNORES line to the KB's .gitignore (creating it if absent). Existing lines are kept as-is. Returns whether it wrote. */
export function ensureKbRuntimeIgnores(dir: string): boolean {
  const file = path.join(dir, ".gitignore");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* none yet */ }
  const lines = text.split("\n").map((l) => l.trim());
  const missing = KB_RUNTIME_IGNORES.filter((l) => !lines.includes(l));
  if (!missing.length) return false;
  fs.writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  return true;
}

const legacyOverlay = (cfg: SquadrantConfig, project: string) =>
  path.join(resolveHome(cfg.projects[project].spokeVault), "knowledge", "rules");

/** Projects with a pre-#936 overlay at <spokeVault>/knowledge/rules/. */
export function findLegacyOverlays(cfg: SquadrantConfig): string[] {
  return Object.keys(cfg.projects).filter((p) => fs.existsSync(legacyOverlay(cfg, p))).sort();
}

/** Move each project's old overlay to projectRulesHome(). Skips (and reports) when there is no home or the target exists. */
export function moveLegacyOverlays(cfg: SquadrantConfig, opts: { dryRun?: boolean } = {}): KbMoveEntry[] {
  return findLegacyOverlays(cfg).map((project): KbMoveEntry => {
    const from = legacyOverlay(cfg, project);
    const to = projectRulesHome(cfg, project);
    const kb = `overlay:${project}`;
    if (!to) return { kb, from, to: "", action: "skipped", note: "no group KB or knowledgeHome for this project; set one, then re-run" };
    if (fs.existsSync(to)) return { kb, from, to, action: "skipped", note: "target already exists; nothing moved" };
    if (opts.dryRun) return { kb, from, to, action: "would-move" };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
      return { kb, from, to, action: "moved" };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      fs.cpSync(from, to, { recursive: true });
      return { kb, from, to, action: "copied", note: "cross-device: original left in place, delete it yourself once verified" };
    }
  });
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
    if (ensureKbGitignore(to)) notes.push("wrote .gitignore (raw/, .converted/)");
    if (fs.existsSync(path.join(to, "index.json"))) notes.push(`index.json is no longer used (the index is a cache now): run squadrant knowledge reindex ${kb}`);
    if (action === "copied") notes.push("cross-device: original left in place, delete it yourself once verified");
    return { kb, from, to, action, ...(notes.length ? { note: notes.join("; ") } : {}) };
  });
}
