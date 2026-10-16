// packages/core/src/knowledge/profile-bridge.ts — native Claude memory → profile proposals (#982 S1, spec §6).
// One-way and read-only on the native side: squadrant never writes ~/.claude/projects/**.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHome, userKbDir, USER_KB, type SquadrantConfig } from "@squadrant/shared";
import { ensureUserKb, loadProfile, profileWritePath, serializeTrait, splitFrontmatter, PROFILE_SUMMARY_MAX, PROPOSED_PROFILE_DIR, UPDATE_SUFFIX, type LoadedTrait, type Trait } from "./profile.js";
import { readDropped, sha12 } from "./profile-write.js";
import { appendAudit, type AuditSink } from "./audit.js";

/** `SQUADRANT_NATIVE_MEMORY_ROOT` overrides ~/.claude/projects (tests). */
export const nativeMemoryRoot = (env: NodeJS.ProcessEnv = process.env) =>
  env.SQUADRANT_NATIVE_MEMORY_ROOT || path.join(os.homedir(), ".claude", "projects");

/** How Claude Code names a project dir (same as deriveTranscriptPath). Compared by equality, never decoded. */
export const encodeClaudeDir = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");

const MEMORY_REF_RE = /^memory:([^/]+)\/([^#]+)#([0-9a-f]{12})$/;

/** Native memory files that back an active trait and still exist: the operator may delete them; squadrant never does. */
export function coveredNativeFiles(cfg: SquadrantConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const root = nativeMemoryRoot(env);
  const out = new Set<string>();
  for (const t of loadProfile(userKbDir(cfg, env)).active) {
    for (const s of t.sources) {
      const m = MEMORY_REF_RE.exec(s);
      const file = m && path.join(root, m[1], "memory", m[2]);
      if (file && fs.existsSync(file)) out.add(file);
    }
  }
  return [...out].sort();
}

/** The allowlisted Claude project dirs (P14): each registered project path, plus $HOME. */
export function allowlistedDirs(cfg: SquadrantConfig, home = os.homedir()): string[] {
  const paths = [...Object.values(cfg.projects ?? {}).map((pc) => path.resolve(resolveHome(pc.path))), home];
  return [...new Set(paths.map(encodeClaudeDir))];
}

/** The bridge runs at daemon boot, then from the 60 s knowledge tick when the last run is this old (P9). */
export const PROFILE_BRIDGE_INTERVAL_MS = 60 * 60 * 1000;
export const PROFILE_BRIDGE_STATE = "profile-bridge.json";
const BRIDGED_TYPES = new Set(["user", "feedback"]);

interface NativeItem { dir: string; file: string; name: string; description: string; body: string; ref: string; source: string }

const normalize = (s: string) => s.replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim();

/** `user`/`feedback` memories in the allowlisted dirs. `type` is top-level or `metadata.type`; MEMORY.md is the index. */
function scanNative(cfg: SquadrantConfig, env: NodeJS.ProcessEnv, home: string): NativeItem[] {
  const root = nativeMemoryRoot(env);
  const items: NativeItem[] = [];
  for (const dir of allowlistedDirs(cfg, home)) {
    const memDir = path.join(root, dir, "memory");
    let names: string[];
    try { names = fs.readdirSync(memDir).filter((n) => n.endsWith(".md") && n !== "MEMORY.md").sort(); } catch { continue; }
    for (const file of names) {
      let parsed: ReturnType<typeof splitFrontmatter>;
      try { parsed = splitFrontmatter(fs.readFileSync(path.join(memDir, file), "utf8")); } catch { continue; }
      if (!parsed) continue;
      const meta = parsed.fm.metadata as { type?: unknown } | undefined;
      const type = parsed.fm.type ?? meta?.type;
      if (typeof type !== "string" || !BRIDGED_TYPES.has(type)) continue;
      const description = typeof parsed.fm.description === "string" ? normalize(parsed.fm.description) : "";
      const body = normalize(parsed.body);
      // Hash only what the operator wrote: metadata.modified / originSessionId churn must not re-propose.
      const ref = `memory:${dir}/${file}`;
      items.push({ dir, file, name: file.slice(0, -3), description, body, ref, source: `${ref}#${sha12(`${description}\n${body}`)}` });
    }
  }
  return items;
}

const refOf = (source: string) => source.replace(/#[0-9a-f]{12}$/, "");
const isMemory = (source: string) => source.startsWith("memory:");

function groupedBody(items: NativeItem[]): string {
  const bodies = [...new Set(items.map((i) => i.body))];
  if (bodies.length <= 1) return `${bodies[0] ?? ""}\n`;
  return `${items.map((i) => `## From ${i.dir}\n\n${i.body}`).join("\n\n")}\n`;
}

/** A draft summary: one line, cut at a word boundary to ≤140 chars. The operator approves the wording at review. */
export function draftSummary(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= PROFILE_SUMMARY_MAX) return s;
  const cut = s.slice(0, PROFILE_SUMMARY_MAX + 1);
  const at = cut.lastIndexOf(" ");
  return (at > 40 ? cut.slice(0, at) : s.slice(0, PROFILE_SUMMARY_MAX)).trim();
}

const baseSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "memory";

export interface BridgeOpts { cfg: SquadrantConfig; env?: NodeJS.ProcessEnv; home?: string; now?: () => Date; audit?: AuditSink }

/**
 * One bridge pass (spec §6): new native notes become proposals grouped by file name; a changed note behind an
 * active trait becomes `<slug>.update.md`. Dedup is derived from files (sources under profile/, _archive/,
 * _proposed/ and _dropped.yaml), never from state. Reads native memory only; never commits.
 */
export function runProfileBridge(o: BridgeOpts): { proposed: string[] } {
  const env = o.env ?? process.env;
  const items = scanNative(o.cfg, env, o.home ?? os.homedir());
  const root = userKbDir(o.cfg, env);
  const p = loadProfile(root);
  const dropped = readDropped(root);
  const known = new Set<string>([...p.active, ...p.archived, ...p.proposed].flatMap((t) => t.sources));
  for (const d of dropped) known.add(`${d.source}#${d.hash}`);
  // Q5: a dropped or archived note stays dropped, whatever its later edits ("drop = stop asking").
  // A dropped *update* only skips that exact hash (review 6); a dropped new item blocks the whole path.
  const blocked = new Set<string>([...dropped.filter((d) => !d.updates).map((d) => d.source), ...p.archived.flatMap((t) => t.sources.filter(isMemory).map(refOf))]);
  const activeByRef = new Map<string, LoadedTrait>();
  for (const t of p.active) for (const s of t.sources.filter(isMemory)) activeByRef.set(refOf(s), t);

  const live = items.filter((i) => !blocked.has(i.ref));
  const nameTarget = new Map<string, LoadedTrait>();
  for (const i of live) { const t = activeByRef.get(i.ref); if (t) nameTarget.set(i.name, t); }
  const updates = new Map<string, { target: LoadedTrait; items: NativeItem[] }>();
  const fresh = new Map<string, NativeItem[]>();
  for (const i of live) {
    const target = activeByRef.get(i.ref) ?? nameTarget.get(i.name);
    if (target) {
      const g = updates.get(target.id) ?? { target, items: [] };
      g.items.push(i);
      updates.set(target.id, g);
    } else fresh.set(i.name, [...(fresh.get(i.name) ?? []), i]);
  }

  const date = (o.now?.() ?? new Date()).toISOString().slice(0, 10);
  const writes: { rel: string; trait: Trait }[] = [];
  for (const { target, items: g } of updates.values()) {
    if (g.every((i) => known.has(i.source))) continue;
    const slug = target.id.slice("prof.".length);
    const scanned = new Set(g.map((i) => i.ref));
    const sources = [...target.sources.filter((s) => !isMemory(s) || !scanned.has(refOf(s))), ...g.map((i) => i.source)];
    writes.push({ rel: `${PROPOSED_PROFILE_DIR}/${slug}${UPDATE_SUFFIX}.md`, trait: {
      id: `${target.id}${UPDATE_SUFFIX}`, domain: "profile", level: "shared", status: "proposed", kind: target.kind, confirmed: false,
      summary: target.summary, audience: target.audience, tier: target.tier, updates: target.id, sources, created: date, updated: date, body: groupedBody(g),
    } });
  }
  const taken = new Set([...p.active, ...p.archived].map((t) => t.id));
  for (const [name, g] of fresh) {
    if (g.every((i) => known.has(i.source))) continue;
    const refs = new Set(g.map((i) => i.ref));
    let slug = baseSlug(name);
    for (let n = 2; ; n++) {
      const pending = p.proposed.find((t) => t.id === `prof.${slug}`);
      const ours = !pending || pending.sources.some((s) => refs.has(refOf(s)));
      if (!taken.has(`prof.${slug}`) && ours) break;
      slug = `${baseSlug(name)}-${n}`;
    }
    const first = g.find((i) => i.description) ?? g[0];
    writes.push({ rel: `${PROPOSED_PROFILE_DIR}/${slug}.md`, trait: {
      id: `prof.${slug}`, domain: "profile", level: "shared", status: "proposed", kind: "preference", confirmed: false,
      summary: draftSummary(first.description || first.body.split("\n").find((l) => l.trim()) || name),
      audience: "all", tier: "core", sources: g.map((i) => i.source), created: date, updated: date, body: groupedBody(g),
    } });
  }
  if (!writes.length) return { proposed: [] };

  const kb = ensureUserKb(o.cfg, env);
  for (const w of writes) {
    const file = profileWritePath(kb, w.rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeTrait(w.trait));
  }
  appendAudit(writes.map((w) => ({ kb: USER_KB, level: "shared", project: "_none", domain: "profile", itemId: w.trait.id, event: "item.proposed" as const })),
    { env, ...o.audit });
  return { proposed: writes.map((w) => w.trait.id) };
}

export interface BridgeRunOpts extends BridgeOpts { stateRoot: string; force?: boolean; log?: (m: string) => void }
export type BridgeRunResult = { status: "ran"; proposed: string[] } | { status: "throttled" | "running" | "error" };

let bridgeInFlight = false;

/** Throttled (60 min, `<stateRoot>/profile-bridge.json`, a cache only), never overlapping, never throwing. */
export async function maybeRunProfileBridge(o: BridgeRunOpts): Promise<BridgeRunResult> {
  if (bridgeInFlight) return { status: "running" };
  const stateFile = path.join(o.stateRoot, PROFILE_BRIDGE_STATE);
  const now = o.now?.() ?? new Date();
  if (!o.force) {
    let last = NaN;
    try { last = Date.parse((JSON.parse(fs.readFileSync(stateFile, "utf8")) as { lastRun?: string }).lastRun ?? ""); } catch { /* never ran */ }
    if (now.getTime() - last < PROFILE_BRIDGE_INTERVAL_MS) return { status: "throttled" };
  }
  bridgeInFlight = true;
  const record = () => { try { fs.mkdirSync(o.stateRoot, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify({ lastRun: now.toISOString() })); } catch { /* cache only */ } };
  try {
    await new Promise((r) => setImmediate(r));
    const r = runProfileBridge(o);
    record();
    if (r.proposed.length) o.log?.(`profile bridge: proposed ${r.proposed.join(", ")} (squadrant profile review)`);
    return { status: "ran", proposed: r.proposed };
  } catch (err) {
    record(); // a broken _user retries next hour, not every tick
    o.log?.(`profile bridge failed: ${(err as Error).message}`);
    return { status: "error" };
  } finally {
    bridgeInFlight = false;
  }
}

/** Daemon boot: one run outside the rotation tick (which waits 60 s and skips when `<stateRoot>/inbox` is unreadable). */
export const bootProfileBridge = (o: BridgeRunOpts) => maybeRunProfileBridge({ ...o, force: true });
