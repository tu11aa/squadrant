// packages/core/src/knowledge/profile-write.ts — `squadrant profile add|review|list` core (#982 S1, spec §4).
// The S3 `knowledge propose --domain profile` / `knowledge review _user` aliases call these same functions.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
import { USER_KB, userKbDir, type SquadrantConfig } from "@squadrant/shared";
import {
  ARCHIVE_DIR, DROPPED_FILE, PROFILE_CORE_CAP, PROFILE_DIR, PROPOSED_PROFILE_DIR, commitProfilePaths, ensureUserKb, loadProfile,
  profileWritePath, serializeTrait, splitFrontmatter, validateTrait, viewSizes, type LoadedTrait, type ProfileCommit, type Trait,
  type TraitAudience, type TraitKind, type TraitTier,
} from "./profile.js";
import { appendAudit, type AuditEventName, type AuditSink } from "./audit.js";
import { resolveInjectProject } from "./inject.js";

export interface ProfileCtx {
  cfg: SquadrantConfig;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => Date;
  audit?: AuditSink;
  /** Session id for the `Session:` trailer and `session:` source. */
  session?: string;
}

export interface ProfileWriteResult { id: string; ok: boolean; line?: string; error?: string; warnings: string[] }

export interface QueueItem {
  id: string;
  type: "new" | "update" | "unconfirmed";
  kind: TraitKind;
  summary: string;
  sources: string[];
  /** Encoded Claude project dir of each `memory:` source (spec P14: review shows where it came from). */
  sourceDirs: string[];
  updates?: string;
  created: string;
  body: string;
}

export const MERGE_HINT = "merge or archive traits first (squadrant profile list)";
const CREW_REVIEW_REFUSAL = "crew sessions cannot confirm, drop or edit profile items; report it in your done message (#556)";

const isCrew = (env: NodeJS.ProcessEnv) => !!env.SQUADRANT_CREW_TASK_ID;
const today = (ctx: ProfileCtx) => (ctx.now?.() ?? new Date()).toISOString().slice(0, 10);
const fmt = (n: number) => n.toLocaleString("en-US");
const sizesText = (s: { captain: number; crew: number }) => `(captain ${fmt(s.captain)}/${fmt(PROFILE_CORE_CAP)} · crew ${fmt(s.crew)}/${fmt(PROFILE_CORE_CAP)})`;
export const sha12 = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
const slugOf = (id: string) => id.replace(/^prof\./, "");
const rel = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");

function auditEvent(ctx: ProfileCtx, event: AuditEventName, id: string, extra: { reason?: string } = {}): void {
  const project = resolveInjectProject(ctx.cfg, ctx.cwd ?? process.cwd(), ctx.env) ?? "_none";
  appendAudit([{ kb: USER_KB, level: "shared", project, domain: "profile", itemId: id, event, ...extra, ...(ctx.session ? { session: ctx.session } : {}) }],
    { env: ctx.env, ...ctx.audit });
}

/** The refusal for an apply that would push a view past the cap, or null. Shrinking edits are always allowed. */
function capRefusal(active: Trait[], next: Trait): string | null {
  const before = viewSizes(active);
  const after = viewSizes([...active.filter((t) => t.id !== next.id), next]);
  const grows = (["captain", "crew"] as const).some((v) => after[v] > PROFILE_CORE_CAP && after[v] > before[v]);
  return grows ? `core profile is ${fmt(Math.max(before.captain, before.crew))}/${fmt(PROFILE_CORE_CAP)} chars: ${MERGE_HINT}` : null;
}

function overCapWarning(active: Trait[]): string[] {
  const s = viewSizes(active);
  return Math.max(s.captain, s.crew) > PROFILE_CORE_CAP ? [`over cap: merge pending ${sizesText(s)}`] : [];
}

/** First words of the summary as a kebab slug. */
export function slugFromSummary(summary: string): string {
  return summary.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean).slice(0, 6).join("-").slice(0, 48).replace(/-+$/, "");
}

interface TraitInput { fm: Partial<Trait>; body: string }
function parseInput(text: string | undefined): TraitInput {
  if (!text) return { fm: {}, body: "" };
  const s = splitFrontmatter(text);
  return s ? { fm: s.fm as Partial<Trait>, body: s.body } : { fm: {}, body: text };
}

function writeTrait(root: string, relPath: string, t: Trait): string {
  const file = profileWritePath(root, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeTrait(t));
  return file;
}

function commit(ctx: ProfileCtx, root: string, paths: string[], c: Omit<ProfileCommit, "session">): string[] {
  const r = commitProfilePaths(root, paths, { ...c, session: ctx.session });
  return r.ok ? [] : [r.warning!];
}

const fail = (id: string, error: string): ProfileWriteResult => ({ id, ok: false, error, warnings: [] });

export interface AddInput {
  text?: string;
  kind?: TraitKind;
  apply?: boolean;
  id?: string;
  summary?: string;
  audience?: TraitAudience;
  tier?: TraitTier;
  session?: string;
}

/** `profile add`: live with --apply (correction: unconfirmed, always applies), else a proposal (spec §4, P4, P12). */
export function addTrait(ctx: ProfileCtx, input: AddInput): ProfileWriteResult {
  const { fm, body } = parseInput(input.text);
  const summary = input.summary ?? fm.summary;
  const rawId = input.id ?? fm.id ?? (typeof summary === "string" ? slugFromSummary(summary) : "");
  const id = `prof.${slugOf(String(rawId))}`;
  const warnings: string[] = [];
  let apply = !!input.apply;
  if (apply && isCrew(ctx.env)) {
    apply = false;
    warnings.push("crew session: --apply is refused, saved as a proposal for the operator (#556)");
  }
  const session = input.session ?? ctx.session;
  const kind = (input.kind ?? fm.kind) as TraitKind;
  const correction = kind === "correction";
  const date = today(ctx);
  const t: Trait = {
    ...fm,
    id, domain: "profile", level: "shared",
    status: apply ? "active" : "proposed",
    kind,
    confirmed: apply && !correction,
    summary: summary as string,
    audience: input.audience ?? fm.audience ?? "all",
    tier: input.tier ?? fm.tier ?? "core",
    sources: fm.sources ?? (session ? [`session:${session}`] : []),
    created: date, updated: date,
    body,
  };
  delete t.last_confirmed;
  if (t.confirmed) t.last_confirmed = date;
  const problems = validateTrait(t, slugOf(id));
  if (problems.length) return fail(id, problems.join("; "));

  const root = ensureUserKb(ctx.cfg, ctx.env);
  const p = loadProfile(root);
  if ([...p.active, ...p.archived, ...p.proposed].some((x) => x.id === id)) {
    return fail(id, `${id} already exists: change it with squadrant profile review --edit ${id} --file -`);
  }
  if (!apply) {
    writeTrait(root, `${PROPOSED_PROFILE_DIR}/${slugOf(id)}.md`, t);
    auditEvent({ ...ctx, session }, "item.proposed", id);
    return { id, ok: true, line: `proposed ${id}: "${t.summary}" ${sizesText(viewSizes(p.active))}`, warnings };
  }
  if (!correction) {
    const refusal = capRefusal(p.active, t);
    if (refusal) return fail(id, refusal);
  }
  const file = writeTrait(root, `${slugOf(id)}.md`, t);
  warnings.push(...commit({ ...ctx, session }, root, [rel(root, file)], { verb: "add", id, approvedBy: correction ? "agent" : "operator" }));
  const active = [...p.active, t];
  if (correction) warnings.push(...overCapWarning(active));
  auditEvent({ ...ctx, session }, "item.applied", id);
  return { id, ok: true, line: `applied ${id}: "${t.summary}" ${sizesText(viewSizes(active))}`, warnings };
}

const memoryDir = (src: string) => /^memory:([^/]+)\//.exec(src)?.[1];

function toQueueItem(t: LoadedTrait, type: QueueItem["type"]): QueueItem {
  return {
    id: t.id, type, kind: t.kind, summary: t.summary, sources: t.sources,
    sourceDirs: [...new Set(t.sources.map(memoryDir).filter((d): d is string => !!d))],
    ...(t.updates ? { updates: t.updates } : {}), created: t.created, body: t.body,
  };
}

/** Proposals, then live traits with `confirmed: false` (spec §4 Review). */
export function reviewQueue(ctx: ProfileCtx): QueueItem[] {
  const p = loadProfile(userKbDir(ctx.cfg, ctx.env));
  return [
    ...p.proposed.map((t) => toQueueItem(t, t.updates ? "update" : "new")),
    ...p.active.filter((t) => !t.confirmed).map((t) => toQueueItem(t, "unconfirmed")),
  ];
}

function keepOne(ctx: ProfileCtx, root: string, id: string): ProfileWriteResult {
  const p = loadProfile(root);
  const date = today(ctx);
  const proposal = p.proposed.find((t) => t.id === id);
  const live = p.active.find((t) => t.id === id);
  if (proposal?.updates) {
    const target = p.active.find((t) => t.id === proposal.updates);
    if (!target) return fail(id, `${proposal.updates} is not an active trait; drop this update proposal`);
    const next: Trait = { ...target, body: proposal.body, sources: proposal.sources, updated: date, last_confirmed: date };
    const file = writeTrait(root, `${slugOf(target.id)}.md`, stripFile(next));
    fs.rmSync(proposal.file);
    const warnings = commit(ctx, root, [rel(root, file)], { verb: "keep", id: target.id, approvedBy: "operator" });
    auditEvent(ctx, "item.applied", target.id);
    return { id, ok: true, line: `updated ${target.id}: "${target.summary}" (summary kept)`, warnings };
  }
  if (proposal) {
    if ([...p.active, ...p.archived].some((t) => t.id === id)) return fail(id, `${id} already exists as a live or archived trait; edit that one instead`);
    const next: Trait = { ...stripFile(proposal), status: "active", confirmed: true, last_confirmed: date, updated: date };
    if (next.kind !== "correction") {
      const refusal = capRefusal(p.active, next);
      if (refusal) return fail(id, refusal);
    }
    const file = writeTrait(root, `${slugOf(id)}.md`, next);
    fs.rmSync(proposal.file);
    const warnings = commit(ctx, root, [rel(root, file)], { verb: "keep", id, approvedBy: "operator" });
    auditEvent(ctx, "item.applied", id);
    return { id, ok: true, line: `applied ${id}: "${next.summary}" ${sizesText(viewSizes([...p.active, next]))}`, warnings };
  }
  if (live) {
    const next: Trait = { ...stripFile(live), confirmed: true, last_confirmed: date };
    const file = writeTrait(root, `${slugOf(id)}.md`, next);
    const warnings = commit(ctx, root, [rel(root, file)], { verb: "confirm", id, approvedBy: "operator" });
    auditEvent(ctx, "item.approved", id);
    return { id, ok: true, line: `confirmed ${id}: "${next.summary}"`, warnings };
  }
  return fail(id, `${id} is not in the review queue`);
}

function stripFile(t: LoadedTrait | Trait): Trait {
  const { file: _f, ...rest } = t as LoadedTrait;
  return rest;
}

/** `review --keep`: one item at a time, one commit each. There is deliberately no keep-all (P14). */
export function keepItems(ctx: ProfileCtx, ids: string[]): ProfileWriteResult[] {
  if (isCrew(ctx.env)) return ids.map((id) => fail(id, CREW_REVIEW_REFUSAL));
  const root = ensureUserKb(ctx.cfg, ctx.env);
  return ids.map((id) => keepOne(ctx, root, id));
}

export interface DroppedEntry { source: string; hash: string; reason: string; date: string }

export function readDropped(root: string): DroppedEntry[] {
  try {
    const v = yaml.load(fs.readFileSync(path.join(root, PROFILE_DIR, DROPPED_FILE), "utf8"), { schema: yaml.JSON_SCHEMA });
    return Array.isArray(v) ? v.filter((e): e is DroppedEntry => typeof e?.source === "string" && typeof e?.hash === "string") : [];
  } catch { return []; }
}

/** `review --drop`: a proposal leaves only {source, hash, reason, date} (P15); an active trait is archived. */
export function dropItems(ctx: ProfileCtx, ids: string[], reason: string): ProfileWriteResult[] {
  if (isCrew(ctx.env)) return ids.map((id) => fail(id, CREW_REVIEW_REFUSAL));
  if (!reason?.trim()) return ids.map((id) => fail(id, "--drop needs --reason \"<why>\" (e.g. \"route: saitex rules\")"));
  const root = ensureUserKb(ctx.cfg, ctx.env);
  return ids.map((id) => {
    const p = loadProfile(root);
    const date = today(ctx);
    const proposal = p.proposed.find((t) => t.id === id);
    if (proposal) {
      const memory = proposal.sources.map((s) => /^(memory:.+)#([0-9a-f]{12})$/.exec(s)).filter((m): m is RegExpExecArray => !!m);
      const entries: DroppedEntry[] = memory.length
        ? memory.map((m) => ({ source: m[1], hash: m[2], reason, date }))
        : [{ source: `proposal:${id}`, hash: sha12(proposal.body), reason, date }];
      const file = profileWritePath(root, DROPPED_FILE);
      fs.writeFileSync(file, yaml.dump([...readDropped(root), ...entries], { lineWidth: -1 }));
      fs.rmSync(proposal.file);
      const warnings = commit(ctx, root, [rel(root, file)], { verb: "drop", id, approvedBy: "operator" });
      auditEvent(ctx, "item.rejected", id, { reason });
      return { id, ok: true, line: `dropped ${id} (${reason})`, warnings };
    }
    const live = p.active.find((t) => t.id === id);
    if (live) {
      const to = writeTrait(root, `${ARCHIVE_DIR}/${slugOf(id)}.md`, { ...stripFile(live), status: "archived", updated: date });
      fs.rmSync(live.file);
      const warnings = commit(ctx, root, [rel(root, live.file), rel(root, to)], { verb: "archive", id, approvedBy: "operator" });
      auditEvent(ctx, "item.archived", id, { reason });
      return { id, ok: true, line: `archived ${id} (${reason})`, warnings };
    }
    return fail(id, `${id} is not a proposal or an active trait`);
  });
}

/** `review --edit <id> --file -`: replace fields and body, then keep. */
export function editItem(ctx: ProfileCtx, id: string, text: string, flags: { summary?: string; audience?: TraitAudience; tier?: TraitTier } = {}): ProfileWriteResult {
  if (isCrew(ctx.env)) return fail(id, CREW_REVIEW_REFUSAL);
  const root = ensureUserKb(ctx.cfg, ctx.env);
  const p = loadProfile(root);
  const base = p.proposed.find((t) => t.id === id && !t.updates) ?? p.active.find((t) => t.id === id);
  if (!base) return fail(id, `${id} is not a new-trait proposal or an active trait (update proposals are kept or dropped)`);
  const { fm, body } = parseInput(text);
  const date = today(ctx);
  const next: Trait = {
    ...stripFile(base), ...fm,
    id, domain: "profile", level: "shared", status: "active", confirmed: true, last_confirmed: date, updated: date,
    ...(flags.summary ? { summary: flags.summary } : {}), ...(flags.audience ? { audience: flags.audience } : {}), ...(flags.tier ? { tier: flags.tier } : {}),
    body: body.trim() ? body : base.body,
  };
  const problems = validateTrait(next, slugOf(id));
  if (problems.length) return fail(id, problems.join("; "));
  if (next.kind !== "correction") {
    const refusal = capRefusal(p.active, next);
    if (refusal) return fail(id, refusal);
  }
  const file = writeTrait(root, `${slugOf(id)}.md`, next);
  if (base.file !== file) fs.rmSync(base.file);
  const warnings = commit(ctx, root, [rel(root, file)], { verb: "edit", id, approvedBy: "operator" });
  auditEvent(ctx, "item.applied", id);
  return { id, ok: true, line: `applied ${id}: "${next.summary}" ${sizesText(viewSizes([...p.active.filter((t) => t.id !== id), next]))}`, warnings };
}

/** `list --check [--fix]`: invalid files and committed-path files git does not have yet; --fix commits the valid ones. */
export function checkProfile(ctx: ProfileCtx, fix: boolean): { problems: string[]; uncommitted: string[]; fixed: string[]; warnings: string[] } {
  if (fix && isCrew(ctx.env)) throw new Error(CREW_REVIEW_REFUSAL);
  const root = userKbDir(ctx.cfg, ctx.env);
  const p = loadProfile(root);
  const problems = p.errors.map((e) => `${rel(root, e.file)}: ${e.problems.join("; ")}`);
  let uncommitted: string[] = [];
  try {
    uncommitted = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all", "--", PROFILE_DIR], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n").filter(Boolean).map((l) => l.slice(3)).sort();
  } catch { if (fs.existsSync(path.join(root, PROFILE_DIR))) problems.push(`${root} is not a git repo`); }
  const fixed: string[] = [];
  const warnings: string[] = [];
  if (fix) {
    const bad = new Set(p.errors.map((e) => rel(root, e.file)));
    for (const f of uncommitted.filter((u) => !bad.has(u))) {
      const id = `prof.${path.basename(f, ".md")}`;
      const w = commit(ctx, root, [f], { verb: "fix", id, approvedBy: "operator" });
      if (w.length) warnings.push(...w); else fixed.push(f);
    }
  }
  return { problems, uncommitted, fixed, warnings };
}
