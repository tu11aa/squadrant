// packages/core/src/knowledge/profile.ts — the operator profile (`_user` KB) store (#982 S1).
// Spec: docs/specs/2026-10-15-user-profile-design.md §3-§4. Files are the source of truth; git is history.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
import { kbConfigs, kbPath, resolveHome, subscribedKbs, userKbDir, USER_KB, type SquadrantConfig } from "@squadrant/shared";

export const PROFILE_CORE_CAP = 3000;
export const PROFILE_SUMMARY_MAX = 140;
export const PROFILE_KINDS = ["preference", "correction", "procedure"] as const;
export const PROFILE_AUDIENCES = ["all", "captain", "crew"] as const;
export const PROFILE_TIERS = ["core", "situational"] as const;
export const PROFILE_STATUSES = ["active", "archived", "proposed"] as const;
export const PROFILE_DIR = "profile";
export const ARCHIVE_DIR = "_archive";
export const PROPOSED_PROFILE_DIR = "_proposed";
export const DROPPED_FILE = "_dropped.yaml";
export const UPDATE_SUFFIX = ".update";
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type TraitKind = (typeof PROFILE_KINDS)[number];
export type TraitAudience = (typeof PROFILE_AUDIENCES)[number];
export type TraitTier = (typeof PROFILE_TIERS)[number];
export type TraitStatus = (typeof PROFILE_STATUSES)[number];

export interface Trait {
  id: string;
  domain: "profile";
  level: "shared";
  status: TraitStatus;
  kind: TraitKind;
  confirmed: boolean;
  last_confirmed?: string;
  summary: string;
  audience: TraitAudience;
  tier: TraitTier;
  /** Stored in S1, used from S2. */
  triggers?: { keywords?: string[] };
  /** `memory:<encoded-dir>/<file>#<hash12>`, `session:<id>`, … */
  sources: string[];
  created: string;
  updated: string;
  /** Update proposals only: the trait they update. */
  updates?: string;
  body: string;
}
export interface LoadedTrait extends Trait { file: string }
export interface ProfileLoad {
  active: LoadedTrait[];
  archived: LoadedTrait[];
  proposed: LoadedTrait[];
  errors: { file: string; problems: string[] }[];
}

const FIELD_ORDER = ["id", "domain", "level", "status", "kind", "confirmed", "last_confirmed", "summary", "audience", "tier",
  "triggers", "updates", "sources", "created", "updated"] as const;
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Frontmatter + body of a markdown file. YAML only, with the JSON schema so dates stay strings. */
export function splitFrontmatter(text: string): { fm: Record<string, unknown>; body: string } | null {
  const m = FM_RE.exec(text);
  if (!m) return null;
  const fm = yaml.load(m[1], { schema: yaml.JSON_SCHEMA });
  return typeof fm === "object" && fm !== null && !Array.isArray(fm) ? { fm: fm as Record<string, unknown>, body: m[2] } : null;
}

export function parseTrait(text: string): Trait {
  const s = splitFrontmatter(text);
  if (!s) throw new Error("missing YAML frontmatter");
  return { ...(s.fm as unknown as Trait), body: s.body };
}

export function serializeTrait(t: Trait): string {
  const fm: Record<string, unknown> = {};
  for (const k of FIELD_ORDER) if (t[k] !== undefined) fm[k] = t[k];
  return `---\n${yaml.dump(fm, { lineWidth: -1, noRefs: true })}---\n${t.body}`;
}

const isUpdateSlug = (slug: string) => slug.endsWith(UPDATE_SUFFIX);

/** Problems with a trait read from `<slug>.md`; empty when valid. */
export function validateTrait(t: Partial<Trait>, fileSlug: string): string[] {
  const p: string[] = [];
  const base = isUpdateSlug(fileSlug) ? fileSlug.slice(0, -UPDATE_SUFFIX.length) : fileSlug;
  if (typeof t.id !== "string" || !t.id.startsWith("prof.")) p.push("id must be prof.<slug>");
  else if (t.id !== `prof.${fileSlug}`) p.push(`id ${t.id} must match the file name (prof.${fileSlug})`);
  if (!SLUG_RE.test(base)) p.push(`slug ${base} must be lowercase words joined by '-'`);
  if (typeof t.summary !== "string" || !t.summary.trim()) p.push("summary is required");
  else {
    if (t.summary.length > PROFILE_SUMMARY_MAX) p.push(`summary is ${t.summary.length} chars; max ${PROFILE_SUMMARY_MAX}`);
    if (/[\r\n]/.test(t.summary)) p.push("summary must be one line");
  }
  if (t.domain !== "profile") p.push("domain must be profile");
  if (t.level !== "shared") p.push("level must be shared");
  const oneOf = (k: keyof Trait, vals: readonly string[]) => { if (!vals.includes(t[k] as string)) p.push(`${k} must be one of ${vals.join("|")}`); };
  oneOf("status", PROFILE_STATUSES);
  oneOf("kind", PROFILE_KINDS);
  oneOf("audience", PROFILE_AUDIENCES);
  oneOf("tier", PROFILE_TIERS);
  if (typeof t.confirmed !== "boolean") p.push("confirmed must be true or false");
  if (!Array.isArray(t.sources) || !t.sources.every((s) => typeof s === "string")) p.push("sources must be a string array");
  if (isUpdateSlug(fileSlug) && t.updates !== `prof.${base}`) p.push(`updates must be prof.${base}`);
  return p;
}

function loadDir(dir: string, out: LoadedTrait[], errors: ProfileLoad["errors"]): void {
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch { return; }
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      const t = parseTrait(fs.readFileSync(file, "utf8"));
      const problems = validateTrait(t, n.slice(0, -3));
      if (problems.length) errors.push({ file, problems });
      else out.push({ ...t, file });
    } catch (err) {
      errors.push({ file, problems: [(err as Error).message] });
    }
  }
}

/** Every trait under `<root>/profile`. Invalid files are skipped and reported, never thrown. */
export function loadProfile(root: string): ProfileLoad {
  const res: ProfileLoad = { active: [], archived: [], proposed: [], errors: [] };
  const dir = path.join(root, PROFILE_DIR);
  loadDir(dir, res.active, res.errors);
  loadDir(path.join(dir, ARCHIVE_DIR), res.archived, res.errors);
  loadDir(path.join(dir, PROPOSED_PROFILE_DIR), res.proposed, res.errors);
  return res;
}

/** Summary chars of active core traits per audience view (spec §3 Cap). */
export function viewSizes(traits: Trait[]): { captain: number; crew: number } {
  const s = { captain: 0, crew: 0 };
  for (const t of traits) {
    if (t.status !== "active" || t.tier !== "core") continue;
    if (t.audience !== "crew") s.captain += t.summary.length;
    if (t.audience !== "captain") s.crew += t.summary.length;
  }
  return s;
}

/** K6: every profile write resolves through here and must land inside `<root>/profile/`. */
export function profileWritePath(root: string, rel: string): string {
  const base = path.join(path.resolve(root), PROFILE_DIR);
  const p = path.resolve(base, rel);
  if (!p.startsWith(base + path.sep)) throw new Error(`refusing profile write outside ${base}: ${p} (K6)`);
  return p;
}

const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

/** K6: `_user` must not sit inside a registered project or another KB. */
function assertUserKbPlacement(cfg: SquadrantConfig, root: string): void {
  for (const [name, pc] of Object.entries(cfg.projects ?? {})) {
    const p = path.resolve(resolveHome(pc.path));
    if (inside(root, p)) throw new Error(`_user KB path ${root} is inside project ${name} (${p}); move it (K6)`);
  }
  const kbs = new Set([
    ...Object.keys(kbConfigs(cfg)),
    ...Object.keys(cfg.projects ?? {}).flatMap((p) => subscribedKbs(cfg, p)),
  ]);
  kbs.delete(USER_KB);
  for (const kb of kbs) {
    const p = path.resolve(kbPath(cfg, kb));
    if (inside(root, p)) throw new Error(`_user KB path ${root} is inside KB ${kb} (${p}); move it (K6)`);
  }
}

const GITIGNORE_LINE = `${PROFILE_DIR}/${PROPOSED_PROFILE_DIR}/`;

function gitRun(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Create the `_user` KB on first use: its own local git repo, proposals ignored. Never adds a remote or registers config. */
export function ensureUserKb(cfg: SquadrantConfig, env: NodeJS.ProcessEnv = process.env): string {
  const root = userKbDir(cfg, env);
  assertUserKbPlacement(cfg, root);
  fs.mkdirSync(path.join(root, PROFILE_DIR), { recursive: true });
  const ignore = path.join(root, ".gitignore");
  let text = "";
  try { text = fs.readFileSync(ignore, "utf8"); } catch { /* new */ }
  const fresh = !fs.existsSync(path.join(root, ".git"));
  if (fresh) gitRun(root, ["init", "-q"]);
  if (!text.split("\n").includes(GITIGNORE_LINE)) {
    fs.writeFileSync(ignore, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${GITIGNORE_LINE}\n`);
    try {
      gitRun(root, ["add", "--", ".gitignore"]);
      gitRun(root, ["commit", "-q", "--only", "-m", fresh ? "profile: init _user KB" : "profile: ignore proposals", "--", ".gitignore"]);
    } catch (err) {
      console.error(`squadrant profile: initial commit failed (${firstLine(err)}); files are kept`);
    }
  }
  return root;
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).trim().split("\n")[0];
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export interface ProfileCommit { verb: string; id: string; session?: string; approvedBy: "operator" | "agent" | "bridge" }

/**
 * `git add` + `git commit --only` of exactly `paths`, so concurrent writers never sweep each other's files.
 * The trailers are the parent spec §5 ones (the S3 daemon writer keeps the format). Never throws.
 */
export function commitProfilePaths(root: string, paths: string[], c: ProfileCommit): { ok: boolean; warning?: string } {
  // Never let git walk up into an enclosing repo.
  if (!fs.existsSync(path.join(root, ".git"))) return { ok: false, warning: `profile: commit failed for ${c.id} (${root} is not a git repo); the file is kept: run squadrant profile list --check --fix` };
  const trailers = [`Domain: profile`, `Item: ${c.id}`, `Level: shared`, `Session: ${c.session || "-"}`, `Approved-by: ${c.approvedBy}`].join("\n");
  for (let attempt = 0; ; attempt++) {
    try {
      gitRun(root, ["add", "-A", "--", ...paths]);
      gitRun(root, ["commit", "-q", "--only", "-m", `profile: ${c.verb} ${c.id}`, "-m", trailers, "--", ...paths]);
      return { ok: true };
    } catch (err) {
      const msg = firstLine(err);
      if (/index\.lock/.test(msg) && attempt < 2) { sleep(200); continue; }
      return { ok: false, warning: `profile: commit failed for ${c.id} (${msg}); the file is kept: run squadrant profile list --check --fix` };
    }
  }
}
