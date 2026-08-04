import fs from "node:fs";
import path from "node:path";

/**
 * Copy `src` → `dest` only if `dest` is missing or its bytes differ. Content
 * comparison (not size+mtime) makes this both correct — a same-size edit is
 * always detected — and idempotent: an unchanged file is never rewritten, so
 * there is no mtime churn across runs. Managed files are small; reading them
 * per invocation is sub-millisecond. Returns true if a copy happened.
 */
function copyIfDifferent(src: string, dest: string): boolean {
  if (fs.existsSync(dest)) {
    if (fs.readFileSync(src).equals(fs.readFileSync(dest))) return false;
  }
  fs.copyFileSync(src, dest);
  return true;
}

/**
 * Mirror `src` into `dest`: recursively copy new/changed files AND prune any
 * dest entry that no longer exists in src. Idempotent — unchanged files are
 * left untouched. After this returns, `dest` is a structural copy of `src`.
 * Caller is responsible for only pointing this at source-managed trees — it
 * WILL delete dest entries absent from src.
 */
export function mirrorDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });

  const srcEntries = fs.readdirSync(src, { withFileTypes: true });
  const srcNames = new Set(srcEntries.map((e) => e.name));

  for (const entry of srcEntries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      mirrorDir(srcPath, destPath);
    } else {
      copyIfDifferent(srcPath, destPath);
    }
  }

  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    if (!srcNames.has(entry.name)) {
      fs.rmSync(path.join(dest, entry.name), { recursive: true, force: true });
    }
  }
}

/**
 * Copy the top-level (non-recursive) files of `src` matching `match` into a
 * flat `dest`, prune dest entries no longer in the matched set, and apply
 * `chmod` to freshly copied files when given. Idempotent — unchanged files
 * are left untouched. For runtime dirs whose source is a differently-named,
 * mixed directory (templates ← templates/, scripts).
 */
export function mirrorFlat(
  src: string,
  dest: string,
  match: RegExp,
  chmod?: number,
): void {
  fs.mkdirSync(dest, { recursive: true });

  const matched = fs
    .readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isFile() && match.test(e.name))
    .map((e) => e.name);
  const matchedSet = new Set(matched);

  for (const name of matched) {
    const destPath = path.join(dest, name);
    const copied = copyIfDifferent(path.join(src, name), destPath);
    if (copied && chmod !== undefined) fs.chmodSync(destPath, chmod);
  }

  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    if (!matchedSet.has(entry.name)) {
      fs.rmSync(path.join(dest, entry.name), { recursive: true, force: true });
    }
  }
}

/**
 * Mirror a plugin dir's `.claude-plugin/` manifest verbatim, but only the
 * allow-listed subdirectories of `skills/` — pruning any dest skill dir not
 * in the list. Used to produce a role-scoped plugin dir (e.g. crew's) that
 * is a strict subset of the full squadrant plugin, so the harness's
 * `--plugin-dir` only ever lists skills that role actually needs.
 */
function mirrorPluginSubset(src: string, dest: string, skills: string[]): void {
  fs.mkdirSync(dest, { recursive: true });
  mirrorDir(path.join(src, ".claude-plugin"), path.join(dest, ".claude-plugin"));

  const skillsDest = path.join(dest, "skills");
  fs.mkdirSync(skillsDest, { recursive: true });
  for (const name of skills) {
    const skillSrc = path.join(src, "skills", name);
    if (fs.existsSync(skillSrc)) mirrorDir(skillSrc, path.join(skillsDest, name));
  }
  for (const entry of fs.readdirSync(skillsDest, { withFileTypes: true })) {
    if (!skills.includes(entry.name)) {
      fs.rmSync(path.join(skillsDest, entry.name), { recursive: true, force: true });
    }
  }
}

/**
 * A source-managed runtime dir. `name` is the dir under the runtime root;
 * `srcRel` is its source dir relative to the package root (note: the
 * runtime `templates/` is sourced from `templates/`).
 */
export type ManagedTarget =
  | { name: string; srcRel: string; mode: "tree" }
  | {
      name: string;
      srcRel: string;
      mode: "flat";
      match: RegExp;
      chmod?: number;
    }
  | { name: string; srcRel: string; mode: "subset"; skills: string[] };

// Crew CLAUDE.md templates only ever tell a crew to apply karpathy-principles
// (see templates/crew.claude.md, templates/crew.generic.md) — captain-ops,
// telegram, wiki-ops, etc. are captain/command-only. Keep this list in sync
// with what the crew templates actually reference.
export const CREW_SKILLS = ["karpathy-principles"];

export const MANAGED_TARGETS: ManagedTarget[] = [
  { name: "plugin", srcRel: "plugin", mode: "tree" },
  { name: "plugin-crew", srcRel: "plugin", mode: "subset", skills: CREW_SKILLS },
  { name: "scripts", srcRel: "scripts", mode: "flat", match: /\.sh$/, chmod: 0o755 },
  {
    name: "templates",
    srcRel: "templates",
    mode: "flat",
    match: /\.(claude\.md|generic\.md|opencode\.md|CLAUDE\.md)$/,
  },
];

export interface EnsureRuntimeSyncedOptions {
  /** Package root containing the source dirs (`plugin/`, `templates/`, …). */
  sourceRoot: string;
  /** Runtime root, normally ~/.config/squadrant. */
  runtimeRoot: string;
  /** Override the managed-target list (defaults to MANAGED_TARGETS). */
  targets?: ManagedTarget[];
}

/**
 * Self-heal the runtime copy of source-managed dirs. Every invocation
 * mirrors each managed target (mirrorDir for tree, mirrorFlat for flat) —
 * idempotent copy-if-different + prune, so the runtime is always reconciled
 * to source. There is no cached state: nothing can claim "synced" while the
 * dest is actually wrong. Only ever touches the runtime dirs named in the
 * target list — never user/runtime state. Never throws — a sync failure
 * degrades to a stderr warning so the CLI stays usable.
 */
export function ensureRuntimeSynced(opts: EnsureRuntimeSyncedOptions): void {
  const targets = opts.targets ?? MANAGED_TARGETS;

  for (const t of targets) {
    const srcDir = path.join(opts.sourceRoot, t.srcRel);
    try {
      if (!fs.existsSync(srcDir)) continue;
      const destDir = path.join(opts.runtimeRoot, t.name);
      if (t.mode === "tree") {
        mirrorDir(srcDir, destDir);
      } else if (t.mode === "flat") {
        mirrorFlat(srcDir, destDir, t.match, t.chmod);
      } else {
        mirrorPluginSubset(srcDir, destDir, t.skills);
      }
    } catch (err) {
      process.stderr.write(
        `squadrant: runtime sync skipped for ${t.name}: ${(err as Error).message}\n`,
      );
    }
  }
}
