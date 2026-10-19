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
import { gitRun, nativeMemoryRoot, nativeNoteHash, readDropped, DROPPED_FILE, PROFILE_DIR } from "@squadrant/core";
import { readNewestArchivedHandoff } from "./handoff-archive.js";

/** Absolute old path -> absolute new path. A path mapped to itself is pinned: it stayed (a `skipped` file). */
export type PathMap = Map<string, string>;

export interface RefSite {
  site: string;
  files: string[];
  /** Reported, never rewritten (archived handoffs are a record of what was true then). */
  readOnly?: boolean;
  /** Keep the file's mtime on rewrite: `handoff facts` dates its checkpoint by it. */
  keepMtime?: boolean;
}

export interface RefHit {
  site: string;
  file: string;
  line: number;
  old: string;
  new: string;
  action: "would-rewrite" | "rewritten" | "report-only";
}

/** A file the sweep changes (or would): its text before and after, and the backup of a real run. */
export interface SweptFile { site: string; file: string; before: string; after: string; backup?: string }
export interface SweepResult { hits: RefHit[]; files: SweptFile[] }

export interface DanglingRef { site: string; file: string; line: number; ref: string }

/**
 * Agent native-memory dirs, per agent. Codex and opencode keep no per-project memory files
 * (~/.codex and ~/.config/opencode hold only AGENTS.md, config and skills, which projection
 * regenerates); add an entry when an agent starts keeping some.
 */
const AGENT_MEMORY_DIRS: Record<string, () => string[]> = {
  claude: () => subdirs(nativeMemoryRoot()).map((d) => path.join(d, "memory")),
};

/** AGENTS.md first: it is canonical, and a CLAUDE.md symlinked to it is then listed once, by its real name. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];
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

const kbRoot = (home: string) => path.join(home, DEFAULT_KB_ROOT.replace(/^~\//, ""));
/** Each KB repo: the dirs under ~/squadrant/kb, the `_user` KB and every configured KB path. */
const kbRepos = (cfg: SquadrantConfig, home: string) =>
  [...new Set([...subdirs(kbRoot(home)), userKbDir(cfg), ...Object.keys(kbConfigs(cfg)).map((kb) => kbPath(cfg, kb))])];

/** The files to scan, by site. A file reachable twice (nested KB roots, CLAUDE.md -> AGENTS.md symlink) is listed once. */
export function refSites(cfg: SquadrantConfig, home = os.homedir()): RefSite[] {
  const projects = subdirs(workspaceRoot());
  // the newest archived handoff is the live checkpoint `handoff facts` reads; older ones are history
  const checkpoints = projects.flatMap((p) => readNewestArchivedHandoff(p, Date.now())?.path ?? []);
  const sites: RefSite[] = [
    ...Object.entries(AGENT_MEMORY_DIRS).map(([agent, dirs]) => ({ site: `memory:${agent}`, files: dirs().flatMap(textFiles) })),
    { site: "workspace", files: projects.flatMap((p) => [path.join(p, "handoff.json"), ...textFiles(path.join(p, "side-handoffs"))]).filter(isFile) },
    { site: "workspace-checkpoint", keepMtime: true, files: checkpoints },
    { site: "workspace-archive", readOnly: true, files: projects.flatMap((p) => archivedHandoffs(path.join(p, "handoffs"))).filter((f) => !checkpoints.includes(f)) },
    { site: "kb", files: [kbRoot(home), ...kbRepos(cfg, home)].flatMap(textFiles) },
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

interface ApplyCtx { dryRun?: boolean; home: string; backupDir: string }

/** One file, line by line: `edit` reports each change through `hit`. Read-only sites and dry runs only report. */
function rewriteFile(
  s: RefSite, file: string, edit: (line: string, hit: (old: string, next: string) => void) => string, c: ApplyCtx, out: SweepResult,
): void {
  const before = fs.readFileSync(file, "utf8");
  const action = s.readOnly ? "report-only" : c.dryRun ? "would-rewrite" : "rewritten";
  const fileHits: RefHit[] = [];
  const after = before.split("\n").map((line, i) => edit(line, (old, next) => fileHits.push({ site: s.site, file, line: i + 1, old, new: next, action }))).join("\n");
  if (!fileHits.length) return;
  out.hits.push(...fileHits);
  if (s.readOnly) return;
  const swept: SweptFile = { site: s.site, file, before, after };
  out.files.push(swept);
  if (c.dryRun) return;
  const { atime, mtime } = fs.statSync(file);
  swept.backup = backup(file, c.backupDir, c.home);
  fs.writeFileSync(file, after);
  if (s.keepMtime) fs.utimesSync(file, atime, mtime);
}

/** Find (dry-run, read-only sites) or rewrite every reference to an old path. Rewritten files are backed up first. */
export function sweepRefs(map: PathMap, sites: RefSite[], opts: { dryRun?: boolean; home?: string; today?: string } = {}): SweepResult {
  const out: SweepResult = { hits: [], files: [] };
  if (![...map].some(([from, to]) => path.resolve(from) !== path.resolve(to))) return out;
  const home = opts.home ?? os.homedir();
  const lookup = new Map<string, { form: Form; to: string }>();
  for (const [from, to] of map) for (const [form, text] of forms(path.resolve(from), home)) lookup.set(text, { form, to: path.resolve(to) });
  // longest first, so a pinned sub-path wins over its moved parent
  const alts = [...lookup.keys()].sort((a, b) => b.length - a.length).map(esc).join("|");
  const re = new RegExp(`${LEFT}(${alts})${RIGHT}${TAIL}`, "g");
  const c = { dryRun: opts.dryRun, home, backupDir: backupDir(opts.today) };
  for (const s of sites) {
    for (const file of s.files) {
      rewriteFile(s, file, (line, hit) => line.replace(re, (match, head: string, tail: string) => {
        const { form, to } = lookup.get(head)!;
        const next = render(form, to, home) + tail;
        if (next === match) return match;
        const [sub] = splitTrail(tail);
        hit(head + sub, render(form, to, home) + sub);
        return next;
      }), c, out);
    }
  }
  return out;
}

const backupDir = (today?: string) => path.join(archiveRoot(), today ?? new Date().toISOString().slice(0, 10), "ref-sweep");

/** Copy the original to <dir>/<path relative to home>; never overwrites an earlier backup (`.1`, `.2`, …). */
function backup(file: string, dir: string, home: string): string {
  const base = path.join(dir, under(file, home) ? path.relative(home, file) : file.replace(/^\/+/, ""));
  let dest = base;
  for (let n = 1; fs.existsSync(dest); n++) dest = `${base}.${n}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  return dest;
}

/**
 * A rewritten Claude memory note gets a new bridge hash, and the bridge would then propose an update
 * identical to the trait. So every `_user` source `memory:<dir>/<file>#<old>` whose old hash matched the note
 * before the rewrite gets the new hash (traits, proposals, archive and `_dropped.yaml`). A note edited since it
 * was bridged keeps its stale hash, so its real update is still proposed.
 */
function refreshProfileHashes(swept: SweptFile[], profileRoot: string, c: ApplyCtx, out: SweepResult): void {
  const subs = new Map<string, string>(); // `memory:<dir>/<file>#<old>` -> new hash
  for (const f of swept) {
    const rel = path.relative(nativeMemoryRoot(), f.file).split(path.sep);
    if (f.site !== "memory:claude" || rel.length !== 3 || rel[1] !== "memory") continue;
    const [was, now] = [nativeNoteHash(f.before), nativeNoteHash(f.after)];
    if (was && now && was !== now) subs.set(`memory:${rel[0]}/${rel[2]}#${was}`, now);
  }
  if (!subs.size) return;
  const dir = path.join(profileRoot, PROFILE_DIR);
  const tokens = new RegExp(`(${[...subs.keys()].map(esc).join("|")})(?![0-9a-f])`, "g");
  // `_dropped.yaml` keeps source and hash apart: map the old hashes of matching entries
  const dropped = new Map(readDropped(profileRoot).flatMap((d) => {
    const now = subs.get(`${d.source}#${d.hash}`);
    return now ? [[d.hash, now] as const] : [];
  }));
  const droppedRe = dropped.size ? new RegExp(`\\b(${[...dropped.keys()].join("|")})\\b`, "g") : null;
  for (const file of textFiles(dir)) {
    const isDropped = file === path.join(dir, DROPPED_FILE);
    rewriteFile({ site: "profile", files: [] }, file, (line, hit) => {
      if (isDropped) return droppedRe ? line.replace(droppedRe, (old) => { hit(old, dropped.get(old)!); return dropped.get(old)!; }) : line;
      return line.replace(tokens, (token) => {
        const next = token.replace(/#[0-9a-f]{12}$/, `#${subs.get(token)}`);
        hit(token, next);
        return next;
      });
    }, c, out);
  }
}

/**
 * Commit the rewritten files of each KB git repo (never push). A file that was untracked, gitignored
 * (`_proposed/`) or already differed from HEAD before the sweep is left uncommitted and named in a note,
 * so the operator's own pending edits never land in a ref-sweep commit.
 */
function commitKbRewrites(swept: SweptFile[], repos: string[], message: string): string[] {
  const originals = new Map<string, Map<string, string>>(); // repo -> file -> content before the sweep
  for (const f of swept) {
    const repo = repos.filter((r) => under(f.file, r)).sort((a, b) => b.length - a.length)[0];
    if (!repo || !f.backup) continue;
    const files = originals.get(repo) ?? new Map<string, string>();
    if (!files.has(f.file)) files.set(f.file, f.before);
    originals.set(repo, files);
  }
  const notes: string[] = [];
  for (const [repo, files] of originals) {
    const rels = [...files.keys()].map((f) => path.relative(repo, f));
    let ignored = new Set<string>();
    try { ignored = new Set(gitRun(repo, ["check-ignore", "--", ...rels]).split("\n").filter(Boolean)); } catch { /* exit 1: none ignored */ }
    const clean: string[] = [];
    const left: string[] = [];
    for (const [file, before] of files) {
      const rel = path.relative(repo, file);
      if (ignored.has(rel)) continue;
      let head: string | null = null;
      try { head = gitRun(repo, ["show", `HEAD:${rel}`]); } catch { /* untracked */ }
      (head === before ? clean : left).push(rel);
    }
    if (clean.length) {
      try {
        gitRun(repo, ["add", "--", ...clean]);
        gitRun(repo, ["commit", "-q", "--only", "-m", message, "--", ...clean]);
        notes.push(`committed ${clean.length} file(s) in ${repo}: ${message}`);
      } catch (err) {
        notes.push(`commit failed in ${repo} (${String((err as Error).message).split("\n")[0]}); the rewrites are kept: ${clean.join(", ")}`);
      }
    }
    if (left.length) notes.push(`not committed in ${repo} (untracked, or it had uncommitted edits before the sweep): ${left.join(", ")}`);
  }
  return notes;
}

/**
 * What a `migrate` run does after its moves: sweep the references, refresh `_user` hashes of rewritten Claude
 * memory notes, then (real run only) commit the rewrites in each KB git repo. Returns the hits and report notes.
 */
export function sweepMoves(
  cfg: SquadrantConfig, map: PathMap, opts: { dryRun?: boolean; home?: string; today?: string } = {},
): { refs: RefHit[]; notes: string[] } {
  const home = opts.home ?? os.homedir();
  const out = sweepRefs(map, refSites(cfg, home), opts);
  if (out.files.some((f) => f.site === "memory:claude")) {
    refreshProfileHashes(out.files, userKbDir(cfg), { dryRun: opts.dryRun, home, backupDir: backupDir(opts.today) }, out);
  }
  if (opts.dryRun || !out.files.length) return { refs: out.hits, notes: [] };
  const moved = [...map].filter(([from, to]) => from !== to);
  const tilde = (p: string) => (under(p, home) ? `~${p.slice(home.length)}` : p);
  const label = moved.length === 1 ? `${tilde(moved[0][0])} -> ${tilde(moved[0][1])}` : `${moved.length} path moves`;
  const repos = kbRepos(cfg, home).filter((r) => fs.existsSync(path.join(r, ".git")));
  return { refs: out.hits, notes: commitKbRewrites(out.files, repos, `ref-sweep: ${label} (#998)`) };
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
