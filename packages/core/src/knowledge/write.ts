// packages/core/src/knowledge/write.ts — the one KB writer (#979 phase 2, D1). Every squadrant write to a KB repo
// commits through commitKbPaths: `git add` + `git commit --only` of exactly the written paths, so concurrent writers
// never sweep each other's files; git's own index.lock serializes them. There is no daemon writer.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { kbConfigs, kbPath, subscribedKbs, USER_KB, type SquadrantConfig } from "@squadrant/shared";
import { ensureKbGitignore, ensureKbRuntimeIgnores, KB_RUNTIME_IGNORES } from "./migrate.js";

/** KB git calls run on the daemon loop too: bounded, and never blocked by a signing prompt. */
export const KB_GIT_TIMEOUT_MS = 10_000;
const PROPOSED = "_proposed";

export function gitRun(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: KB_GIT_TIMEOUT_MS, ...(env ? { env } : {}) });
}

export function gitErrorLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).trim().split("\n")[0];
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The five trailers every squadrant KB commit carries (arch spec §5). `-` when a field does not apply. */
export interface KbTrailers {
  domain: string;
  /** One `Item:` trailer each; empty ⇒ `Item: -`. */
  items: string[];
  level: string;
  session?: string;
  approvedBy: string;
}
export interface KbCommit {
  message: string;
  trailers: KbTrailers;
  /** What the warning tells the operator to run when the commit fails. */
  hint?: string;
}
export interface KbCommitResult { ok: boolean; committed: boolean; warning?: string }

const DOCTOR_HINT = "squadrant knowledge doctor --fix";

export function trailerText(t: KbTrailers): string {
  const items = t.items.length ? [...new Set(t.items)] : ["-"];
  return [`Domain: ${t.domain}`, ...items.map((i) => `Item: ${i}`), `Level: ${t.level}`, `Session: ${t.session || "-"}`, `Approved-by: ${t.approvedBy}`].join("\n");
}

/** Session trailer for CLI writes: the crew task, else the Claude session, else `-`. */
export function kbSession(env: NodeJS.ProcessEnv = process.env): string {
  return env.SQUADRANT_CREW_TASK_ID || env.CLAUDE_CODE_SESSION_ID || "-";
}

const isProposal = (p: string) => p.split(/[\\/]/).includes(PROPOSED);
const label = (c: KbCommit) => (c.trailers.items.length === 1 ? c.trailers.items[0] : c.message);

/** Repo-relative paths with a change git can see (ignored files never show up); no `rels` ⇒ the whole repo. */
function changedPaths(root: string, rels: string[]): string[] {
  const out = gitRun(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...rels]).split("\0");
  const paths: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") i++; // the next field is the rename source
  }
  return [...new Set(paths)];
}

function relPaths(root: string, paths: string[]): string[] | string {
  const base = path.resolve(root);
  const rels: string[] = [];
  for (const p of paths) {
    const rel = path.relative(base, path.resolve(base, p));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return `refusing to commit ${p}: outside the KB ${base}`;
    rels.push(rel.split(path.sep).join("/"));
  }
  return rels;
}

function withLockRetry<T>(fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try { return fn(); } catch (err) {
      if (/index\.lock/.test(gitErrorLine(err)) && attempt < 2) { sleep(200); continue; }
      throw err;
    }
  }
}

/**
 * Commit exactly `paths` (KB-relative or absolute) in the KB repo at `kbRoot`. Paths with no change (or ignored) are
 * skipped; nothing changed ⇒ no commit. Refuses any `_proposed/` path: proposals are never committed (D7, P15).
 * Never throws: on failure the files stand and a warning names the fix.
 */
export function commitKbPaths(kbRoot: string, paths: string[], c: KbCommit): KbCommitResult {
  const hint = c.hint ?? DOCTOR_HINT;
  const proposal = paths.find(isProposal);
  if (proposal) return { ok: false, committed: false, warning: `knowledge: refusing to commit ${proposal}: proposals are never committed` };
  // Never let git walk up into an enclosing repo.
  if (!fs.existsSync(path.join(kbRoot, ".git"))) return { ok: false, committed: false, warning: `knowledge: commit failed for ${label(c)} (${kbRoot} is not a git repo); the files are kept: run ${hint}` };
  const rels = relPaths(kbRoot, paths);
  if (typeof rels === "string") return { ok: false, committed: false, warning: `knowledge: ${rels}` };
  if (!rels.length) return { ok: true, committed: false };
  try {
    return withLockRetry(() => {
      const changed = changedPaths(kbRoot, rels);
      if (!changed.length) return { ok: true, committed: false };
      gitRun(kbRoot, ["add", "-A", "--", ...changed]);
      gitRun(kbRoot, ["commit", "-q", "--only", "-m", c.message, "-m", trailerText(c.trailers), "--", ...changed]);
      return { ok: true, committed: true };
    });
  } catch (err) {
    return { ok: false, committed: false, warning: `knowledge: commit failed for ${label(c)} (${gitErrorLine(err)}); the files are kept: run ${hint}` };
  }
}

/**
 * Stop tracking `untrack` (the files stay on disk) and commit that together with `add`, in one commit built on a
 * private index so nothing another writer staged is swept in (`commit --only` would re-add the files). Used by
 * `knowledge doctor --fix` for the D7 layout: `index.json`, `verdicts.jsonl`, runtime files, tracked proposals.
 */
export function untrackKbPaths(kbRoot: string, untrack: string[], add: string[], c: KbCommit): KbCommitResult {
  if (!fs.existsSync(path.join(kbRoot, ".git"))) return { ok: false, committed: false, warning: `knowledge: ${kbRoot} is not a git repo` };
  const rels = relPaths(kbRoot, [...untrack, ...add]);
  if (typeof rels === "string") return { ok: false, committed: false, warning: `knowledge: ${rels}` };
  const tmpIndex = path.join(os.tmpdir(), `squadrant-kb-index-${crypto.randomBytes(6).toString("hex")}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    return withLockRetry(() => {
      const head = gitRun(kbRoot, ["rev-parse", "HEAD"]).trim();
      gitRun(kbRoot, ["read-tree", head], env);
      if (untrack.length) gitRun(kbRoot, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ...rels.slice(0, untrack.length)], env);
      if (add.length) gitRun(kbRoot, ["add", "-A", "--", ...rels.slice(untrack.length)], env);
      const tree = gitRun(kbRoot, ["write-tree"], env).trim();
      if (tree === gitRun(kbRoot, ["rev-parse", `${head}^{tree}`]).trim()) return { ok: true, committed: false };
      const commit = gitRun(kbRoot, ["commit-tree", tree, "-p", head, "-m", c.message, "-m", trailerText(c.trailers)]).trim();
      gitRun(kbRoot, ["update-ref", "-m", c.message, "HEAD", commit, head]);
      // Bring the real index in line with the new HEAD for exactly these paths.
      gitRun(kbRoot, ["reset", "-q", "HEAD", "--", ...rels]);
      return { ok: true, committed: true };
    });
  } catch (err) {
    return { ok: false, committed: false, warning: `knowledge: untrack commit failed in ${kbRoot} (${gitErrorLine(err)}); nothing was changed in git` };
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

/** Roots of every KB the config knows (registered, group, home or subscribed), `_user` excluded. */
export function knownKbRoots(cfg: SquadrantConfig): string[] {
  const kbs = new Set([
    ...Object.keys(kbConfigs(cfg)),
    ...Object.values(cfg.groups ?? {}).map((g) => g.kb).filter((k): k is string => !!k),
    ...Object.keys(cfg.projects ?? {}).flatMap((p) => subscribedKbs(cfg, p)),
  ]);
  kbs.delete(USER_KB);
  return [...kbs].map((kb) => path.resolve(kbPath(cfg, kb)));
}

/** The KB repo that owns `file`, or undefined: a `repo:docs` home is a code repo, never committed by a KB write (D6). */
export function kbRootOf(cfg: SquadrantConfig, file: string, extraRoots: string[] = []): string | undefined {
  const f = path.resolve(file);
  return [...knownKbRoots(cfg), ...extraRoots.map((r) => path.resolve(r))].filter((r) => inside(f, r)).sort((a, b) => b.length - a.length)[0];
}

/** `project` for a file under `<kb>/projects/<p>/`, else `shared`. */
export const kbLevelOf = (kbRoot: string, file: string): "project" | "shared" =>
  path.relative(kbRoot, path.resolve(file)).split(path.sep)[0] === "projects" ? "project" : "shared";

/**
 * Commit item files per owning KB, one commit each; `Item:` is each file's id (its name) and `Level:` follows the
 * path. Files outside every KB (`repo:docs`) are left as a working-tree diff for the project's PR (D6).
 */
export function commitKbFiles(
  cfg: SquadrantConfig, files: Iterable<string>, c: { message: string; trailers: Omit<KbTrailers, "items" | "level"> }, extraRoots: string[] = [],
): string[] {
  const byRoot = new Map<string, string[]>();
  for (const f of files) {
    const root = kbRootOf(cfg, f, extraRoots);
    if (root) byRoot.set(root, [...(byRoot.get(root) ?? []), f]);
  }
  const warnings: string[] = [];
  for (const [root, list] of byRoot) {
    const levels = new Set(list.map((f) => kbLevelOf(root, f)));
    const r = commitKbPaths(root, list, {
      message: c.message,
      trailers: { ...c.trailers, items: list.map((f) => path.basename(f, ".md")), level: levels.size === 1 ? [...levels][0] : "mixed" },
    });
    if (r.warning) warnings.push(r.warning);
  }
  return warnings;
}

// ---------- knowledge doctor: is the KB repo clean? (phase 2 §5, C3) ----------

/** Files that sit at the KB root but are never committed (D7). */
const ROOT_NEVER_COMMITTED = KB_RUNTIME_IGNORES.filter((l) => l.startsWith("/")).map((l) => l.slice(1));
const neverCommitted = (rel: string) => isProposal(rel) || ROOT_NEVER_COMMITTED.includes(rel);

export interface KbRepoCheck {
  kb: string;
  root: string;
  notRepo: boolean;
  /** D7 lines missing from `.gitignore`. */
  missingIgnores: string[];
  /** Tracked files D7 says are never committed (`index.json`, `verdicts.jsonl`, runtime files, proposals). */
  trackedNeverCommitted: string[];
  /** Other changes git sees: a squadrant commit that failed, or item files edited outside a squadrant write. */
  uncommitted: string[];
}

export function checkKbRepo(kb: string, root: string): KbRepoCheck {
  const res: KbRepoCheck = { kb, root, notRepo: false, missingIgnores: [], trackedNeverCommitted: [], uncommitted: [] };
  if (!fs.existsSync(path.join(root, ".git"))) return { ...res, notRepo: true };
  let lines: string[] = [];
  try { lines = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n").map((l) => l.trim()); } catch { /* none */ }
  res.missingIgnores = KB_RUNTIME_IGNORES.filter((l) => !lines.includes(l));
  res.trackedNeverCommitted = gitRun(root, ["ls-files", "-z"]).split("\0").filter((f) => f && neverCommitted(f)).sort();
  res.uncommitted = changedPaths(root, []).filter((f) => f !== ".gitignore" && !neverCommitted(f)).sort();
  return res;
}

/** Domain/Item/Level trailers of one KB file from its path: `shared/<domain>/…` or `projects/<p>/<domain>/…`. */
function fileTrailers(rel: string): Pick<KbTrailers, "domain" | "items" | "level"> {
  const parts = rel.split("/");
  const level = parts[0] === "projects" ? "project" : parts[0] === "shared" ? "shared" : "-";
  const domain = (level === "project" ? parts[2] : level === "shared" ? parts[1] : undefined) ?? "-";
  return { domain, items: rel.endsWith(".md") ? [path.basename(rel, ".md")] : [], level };
}

export interface KbRepoFix { fixed: string[]; warnings: string[]; uncommitted: string[]; committed: string[] }

/**
 * `knowledge doctor --fix` for one KB. Mechanical fixes run without asking: ensure the D7 `.gitignore`, stop tracking
 * never-committed files, commit that. Other uncommitted files are only committed when `confirm` says yes (a TTY
 * outside a crew session), one commit each, `Approved-by: operator`, `Session: -`; otherwise they are listed.
 */
export function fixKbRepo(kb: string, root: string, o: { confirm?: (files: string[]) => boolean; session?: string } = {}): KbRepoFix {
  const out: KbRepoFix = { fixed: [], warnings: [], uncommitted: [], committed: [] };
  const before = checkKbRepo(kb, root);
  if (before.notRepo) { out.warnings.push(`${root} is not a git repo: run git init there (or squadrant knowledge init ${kb})`); return out; }
  const wroteIgnore = ensureKbGitignore(root) || ensureKbRuntimeIgnores(root);
  const c: KbCommit = {
    message: before.trackedNeverCommitted.length ? "knowledge: stop tracking files that are never committed" : "knowledge: ensure .gitignore",
    trailers: { domain: "-", items: [], level: "-", session: o.session ?? kbSession(), approvedBy: "operator" },
  };
  const r = before.trackedNeverCommitted.length ? untrackKbPaths(root, before.trackedNeverCommitted, [".gitignore"], c) : commitKbPaths(root, [".gitignore"], c);
  if (r.warning) out.warnings.push(r.warning);
  else {
    if (wroteIgnore) out.fixed.push(`.gitignore: added ${before.missingIgnores.join(", ")}`);
    if (before.trackedNeverCommitted.length) out.fixed.push(`untracked (kept on disk): ${before.trackedNeverCommitted.join(", ")}`);
  }
  const left = checkKbRepo(kb, root).uncommitted;
  if (!left.length || !o.confirm?.(left)) { out.uncommitted = left; return out; }
  for (const f of left) {
    const cr = commitKbPaths(root, [f], { message: `knowledge: commit outside edit ${f}`, trailers: { ...fileTrailers(f), session: "-", approvedBy: "operator" } });
    if (cr.warning) { out.warnings.push(cr.warning); out.uncommitted.push(f); } else out.committed.push(f);
  }
  return out;
}
