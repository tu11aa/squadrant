// ref-sweep.ts — #998: after a path move, report (dry-run) or rewrite (real run) every file that
// still cites the old path, and (doctor) list cited home paths that no longer exist. The sites
// are the files agents and captains read paths from: agent native memory, live workspace
// handoffs, KB repos, and each registered project's CLAUDE.md/AGENTS.md/GEMINI.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveRoot, kbConfigs, kbPath, resolveHome, userKbDir, workspaceRoot, DEFAULT_KB_ROOT, type SquadrantConfig,
} from "@squadrant/shared";
import { nativeMemoryRoot } from "@squadrant/core";

/** Absolute old path -> absolute new path. A path mapped to itself is pinned: it stayed (a `skipped` file). */
export type PathMap = Map<string, string>;

export interface RefSite {
  site: string;
  files: string[];
  /** Reported, never rewritten (archived handoffs are a record of what was true then). */
  readOnly?: boolean;
}

export interface RefHit {
  site: string;
  file: string;
  line: number;
  old: string;
  new: string;
  action: "would-rewrite" | "rewritten" | "report-only";
}

export interface DanglingRef { site: string; file: string; line: number; ref: string }

/**
 * Agent native-memory dirs, per agent. Codex and opencode keep no per-project memory files
 * (~/.codex and ~/.config/opencode hold only AGENTS.md, config and skills, which projection
 * regenerates); add an entry when an agent starts keeping some.
 */
const AGENT_MEMORY_DIRS: Record<string, () => string[]> = {
  claude: () => subdirs(nativeMemoryRoot()).map((d) => path.join(d, "memory")),
};

const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];
/** KB `raw/` holds source documents whose sha rules cite; `.converted/` is a cache. */
const SKIP_DIRS = new Set([".git", "node_modules", "raw", ".converted"]);
/** Text files only: a KB's derived `index.json` is regenerated, never edited. */
const TEXT_EXT = new Set([".md", ".yaml", ".yml"]);

function subdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch { return []; }
}

/** Every text file under dir (recursive, symlinks not followed). */
function textFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : textFiles(full);
    return e.isFile() && TEXT_EXT.has(path.extname(e.name)) ? [full] : [];
  });
}

function archivedHandoffs(dir: string): string[] {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f)); } catch { return []; }
}

const isFile = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

/** The files to scan, by site. A file reachable twice (nested KB roots, CLAUDE.md -> AGENTS.md symlink) is listed once. */
export function refSites(cfg: SquadrantConfig, home = os.homedir()): RefSite[] {
  const projects = subdirs(workspaceRoot());
  const kbRoots = [path.join(home, DEFAULT_KB_ROOT.replace(/^~\//, "")), userKbDir(cfg), ...Object.keys(kbConfigs(cfg)).map((kb) => kbPath(cfg, kb))];
  const sites: RefSite[] = [
    ...Object.entries(AGENT_MEMORY_DIRS).map(([agent, dirs]) => ({ site: `memory:${agent}`, files: dirs().flatMap(textFiles) })),
    { site: "workspace", files: projects.flatMap((p) => [path.join(p, "handoff.json"), ...textFiles(path.join(p, "side-handoffs"))]).filter(isFile) },
    { site: "workspace-archive", readOnly: true, files: projects.flatMap((p) => archivedHandoffs(path.join(p, "handoffs"))) },
    { site: "kb", files: kbRoots.flatMap(textFiles) },
    { site: "project", files: Object.values(cfg.projects ?? {}).flatMap((pc) => INSTRUCTION_FILES.map((f) => path.join(resolveHome(pc.path), f))).filter(isFile) },
  ];
  const seen = new Set<string>();
  for (const s of sites) {
    s.files = s.files.filter((f) => {
      const real = fs.realpathSync(f);
      if (seen.has(real)) return false;
      seen.add(real);
      return true;
    });
  }
  return sites;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Not preceded by a path char: `/x/Users/a` is not `/Users/a`, `file:~/a` is `~/a`. */
const LEFT = String.raw`(?<![\w.~$/-])`;
/** Not followed by more of the same segment: `~/a/work` does not match `~/a/workshop` or `~/a/work.md`. */
const RIGHT = String.raw`(?![\w-]|\.[\w-])`;
/** The rest of the path (a sub-path). Stops at whitespace, quotes, backticks, brackets. */
const TAIL = String.raw`((?:/[^\s"'\`()[\]]*)?)`;
/** Sentence punctuation after a path is not part of it. */
const splitTrail = (tail: string) => {
  const m = /[.,:;!?]*$/.exec(tail)!;
  return [tail.slice(0, m.index), m[0]] as const;
};

type Form = "abs" | "~" | "$HOME";
const under = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");
/** How a path is written: absolute, and `~/…` / `$HOME/…` when it is under home. */
function forms(p: string, home: string): [Form, string][] {
  if (!under(p, home)) return [["abs", p]];
  const rel = p.slice(home.length);
  return [["abs", p], ["~", `~${rel}`], ["$HOME", `$HOME${rel}`]];
}
/** `to` written the way the old path was (`~` stays `~` when `to` is under home). */
const render = (form: Form, to: string, home: string) => (form !== "abs" && under(to, home) ? form + to.slice(home.length) : to);

/** Find (dry-run, read-only sites) or rewrite every reference to an old path. Rewritten files are backed up first. */
export function sweepRefs(map: PathMap, sites: RefSite[], opts: { dryRun?: boolean; home?: string; today?: string } = {}): RefHit[] {
  if (![...map].some(([from, to]) => path.resolve(from) !== path.resolve(to))) return [];
  const home = opts.home ?? os.homedir();
  const lookup = new Map<string, { form: Form; to: string }>();
  for (const [from, to] of map) for (const [form, text] of forms(path.resolve(from), home)) lookup.set(text, { form, to: path.resolve(to) });
  // longest first, so a pinned sub-path wins over its moved parent
  const alts = [...lookup.keys()].sort((a, b) => b.length - a.length).map(esc).join("|");
  const re = new RegExp(`${LEFT}(${alts})${RIGHT}${TAIL}`, "g");
  const day = opts.today ?? new Date().toISOString().slice(0, 10);

  const hits: RefHit[] = [];
  for (const s of sites) {
    for (const file of s.files) {
      const text = fs.readFileSync(file, "utf8");
      const fileHits: RefHit[] = [];
      const action = s.readOnly ? "report-only" : opts.dryRun ? "would-rewrite" : "rewritten";
      const out = text.split("\n").map((line, i) => line.replace(re, (match, head: string, tail: string) => {
        const { form, to } = lookup.get(head)!;
        const next = render(form, to, home) + tail;
        if (next === match) return match;
        const [sub] = splitTrail(tail);
        fileHits.push({ site: s.site, file, line: i + 1, old: head + sub, new: render(form, to, home) + sub, action });
        return next;
      })).join("\n");
      hits.push(...fileHits);
      if (!fileHits.length || action !== "rewritten") continue;
      backup(file, path.join(archiveRoot(), day, "ref-sweep"), home);
      fs.writeFileSync(file, out);
    }
  }
  return hits;
}

/** Copy the original to <dir>/<path relative to home>; never overwrites an earlier backup (`.1`, `.2`, …). */
function backup(file: string, dir: string, home: string): string {
  const base = path.join(dir, under(file, home) ? path.relative(home, file) : file.replace(/^\/+/, ""));
  let dest = base;
  for (let n = 1; fs.existsSync(dest); n++) dest = `${base}.${n}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  return dest;
}

/** The path map for a `migrate` report: moved/archived/copied rows map old -> new, `skipped` rows pin the path that stayed. */
export function moveMap(rows: { from: string; to: string; action: string }[]): PathMap {
  const map: PathMap = new Map();
  for (const r of rows) {
    if (r.action === "skipped") map.set(r.from, r.from);
    else if (r.to && ["would-move", "would-archive", "moved", "archived", "copied"].includes(r.action)) map.set(r.from, r.to);
  }
  return map;
}

/** Globs, placeholders and elisions are patterns, not paths. */
const PLACEHOLDER_RE = /[*<{]|\.\.\.|…/;
/** Temp and scratchpad paths are expected to vanish. */
const TEMP_RE = /(^|\/)(tmp|temp|scratchpad)(\/|$)/i;

/** Read-only: every `~/…`, `$HOME/…` or absolute home path cited in a site (archived handoffs excluded) that does not exist. */
export function danglingRefs(sites: RefSite[], home = os.homedir()): DanglingRef[] {
  const re = new RegExp(`${LEFT}(~|\\$HOME|${esc(home)})${RIGHT}${TAIL}`, "g");
  const out: DanglingRef[] = [];
  for (const s of sites) {
    if (s.readOnly) continue;
    for (const file of s.files) {
      fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        for (const m of line.matchAll(re)) {
          // drop sentence punctuation, a `:line[:col]` suffix and a `#anchor`
          const rel = splitTrail(m[2])[0].replace(/#.*$/, "").replace(/(:\d+)+$/, "");
          if (!rel || PLACEHOLDER_RE.test(rel) || TEMP_RE.test(rel)) continue;
          if (!fs.existsSync(home + rel)) out.push({ site: s.site, file, line: i + 1, ref: m[1] + rel });
        }
      });
    }
  }
  return out;
}
