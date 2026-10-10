// packages/core/src/knowledge/schedule.ts — reconcile scheduler (rules spec §5, KB spec §8, #898).
// State in `stateRoot/knowledge-schedule.json`. The daemon only *requests* a pass (a captain.message to the
// KB's homeProject captain); it never spawns a crew. Everything here is deterministic and clock-injected.
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RECONCILE, kbConfigs, resolveKbConfig, type KnowledgeSourceEntry, type ReconcileConfig, type SquadrantConfig } from "@squadrant/shared";
import { detectChange, expandSource, readState } from "./ingest.js";
import { loadKbRules } from "./layers.js";
import { kbDir } from "./paths.js";
import { loadSources } from "./sources.js";

export type PassKind = "incremental" | "full";
export interface RunningPass { pass: PassKind; startedAt: string; sourceSnapshot: Record<string, string> }
export interface ScheduleEntry {
  /** First time this KB was seen; the 30d full cadence counts from here until a full pass has run. */
  createdAt?: string;
  firstChangeAt?: string;
  /** Fixed at firstChangeAt + incrementalAfterDays; later changes never push it back. */
  incrementalDueAt?: string;
  lastFullAt?: string;
  running?: RunningPass;
}
export type Schedule = Record<string, ScheduleEntry>;

export const RUNNING_STALE_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const scheduleFile = (stateRoot: string) => path.join(stateRoot, "knowledge-schedule.json");

export function readSchedule(stateRoot: string): Schedule {
  try { return JSON.parse(fs.readFileSync(scheduleFile(stateRoot), "utf8")) as Schedule; } catch { return {}; }
}
export function writeSchedule(stateRoot: string, s: Schedule): void {
  fs.mkdirSync(stateRoot, { recursive: true });
  const tmp = `${scheduleFile(stateRoot)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, scheduleFile(stateRoot));
}

export const reconcileConfig = (cfg: SquadrantConfig, kb: string): ReconcileConfig =>
  ({ ...DEFAULT_RECONCILE, ...kbConfigs(cfg)[kb]?.reconcile });

/** ref → sha of every source file now. Taken at pass start so later edits open the next window. */
export function snapshotSources(kbRoot: string, sources: KnowledgeSourceEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of sources) for (const f of expandSource(kbRoot, e)) { const d = detectChange(kbRoot, f); out[d.ref] = d.stamp.sha; }
  return out;
}

/** Refs that need extraction: new or edited since the last ingest, or carried over by the section cap. */
export function changedRefs(kbRoot: string, sources: KnowledgeSourceEntry[]): string[] {
  const out: string[] = [];
  for (const e of sources) {
    for (const f of expandSource(kbRoot, e)) {
      const d = detectChange(kbRoot, f);
      const st = readState(kbRoot, d.ref);
      if (d.changed || (st && st.cursor < st.sections)) out.push(d.ref);
    }
  }
  return out;
}

/** Pure: which pass (if any) is due. A full pass absorbs a due incremental one. */
export function duePass(entry: ScheduleEntry, o: { now: Date; rc: ReconcileConfig; empty: boolean }): PassKind | null {
  const now = o.now.getTime();
  if (o.empty && !entry.lastFullAt) return "full";
  const fullBase = entry.lastFullAt ?? entry.createdAt;
  if (fullBase && now >= Date.parse(fullBase) + o.rc.fullEveryDays * DAY_MS) return "full";
  if (entry.firstChangeAt && entry.incrementalDueAt && now >= Date.parse(entry.incrementalDueAt)) return "incremental";
  return null;
}

/** Single-flight: false while a non-stale pass runs. A pass older than 6h is dead and is taken over. */
export function acquirePass(entry: ScheduleEntry, pass: PassKind, now: Date, snapshot: Record<string, string>, log?: (m: string) => void): boolean {
  if (entry.running) {
    if (now.getTime() - Date.parse(entry.running.startedAt) <= RUNNING_STALE_MS) return false;
    log?.(`knowledge: clearing stale ${entry.running.pass} pass started ${entry.running.startedAt}`);
  }
  entry.running = { pass, startedAt: now.toISOString(), sourceSnapshot: snapshot };
  return true;
}

export function requestText(kb: string, pass: PassKind): string {
  const absorbed = pass === "full" ? " (absorbs any pending incremental pass)" : "";
  return `KB ${kb}: ${pass} reconcile due${absorbed}. Spawn a crew with the knowledge-review skill: `
    + `it extracts changed sources, reviews proposals, then runs \`squadrant knowledge reconcile ${kb}${pass === "full" ? " --full" : ""} --finish\`.`;
}

export interface RequestDeps {
  cfg: SquadrantConfig;
  stateRoot: string;
  /** Mailbox write to the captain: appendCaptainMessage in production, a fake in tests. */
  enqueue: (project: string, text: string) => Promise<unknown> | void;
  now?: () => Date;
  log?: (m: string) => void;
}
export interface RequestResult { kb: string; pass: PassKind; requested: boolean; reason?: string }

/** Take the lock, snapshot sources, and enqueue the request. Used by the tick and by `reconcile --now`. */
export async function requestPass(kb: string, pass: PassKind, d: RequestDeps, opts: { dryRun?: boolean } = {}): Promise<RequestResult> {
  const now = d.now?.() ?? new Date();
  const home = resolveKbConfig(d.cfg, kb).homeProject;
  if (!home) return { kb, pass, requested: false, reason: "no homeProject configured" };
  const schedule = readSchedule(d.stateRoot);
  const entry = (schedule[kb] ??= { createdAt: now.toISOString() });
  const root = kbDir(d.cfg, kb);
  if (opts.dryRun) {
    const busy = entry.running && now.getTime() - Date.parse(entry.running.startedAt) <= RUNNING_STALE_MS;
    return { kb, pass, requested: false, reason: busy ? `a ${entry.running!.pass} pass is already running` : `dry run: would enqueue to ${home}` };
  }
  const snapshot = snapshotSources(root, loadSources(root).sources);
  if (!acquirePass(entry, pass, now, snapshot, d.log)) return { kb, pass, requested: false, reason: `a ${entry.running!.pass} pass is already running` };
  writeSchedule(d.stateRoot, schedule);
  try { await d.enqueue(home, requestText(kb, pass)); }
  catch (e) {
    delete entry.running;
    writeSchedule(d.stateRoot, schedule);
    throw e;
  }
  return { kb, pass, requested: true };
}

/** The daemon's 60s hook: record first-change windows and request any due pass. Never throws. */
export async function tickKnowledgeSchedule(d: RequestDeps): Promise<RequestResult[]> {
  const out: RequestResult[] = [];
  const now = d.now?.() ?? new Date();
  for (const kb of Object.keys(kbConfigs(d.cfg))) {
    if (!resolveKbConfig(d.cfg, kb).homeProject) continue;
    try {
      const root = kbDir(d.cfg, kb);
      if (!fs.existsSync(root)) continue;
      const { sources } = loadSources(root);
      if (!sources.length) continue;
      const schedule = readSchedule(d.stateRoot);
      const entry = (schedule[kb] ??= { createdAt: now.toISOString() });
      const rc = reconcileConfig(d.cfg, kb);
      let dirty = false;
      if (entry.running && now.getTime() - Date.parse(entry.running.startedAt) > RUNNING_STALE_MS) { d.log?.(`knowledge: ${kb} pass stale, cleared`); delete entry.running; dirty = true; }
      if (!entry.running && !entry.firstChangeAt && changedRefs(root, sources).length) {
        entry.firstChangeAt = now.toISOString();
        entry.incrementalDueAt = new Date(now.getTime() + rc.incrementalAfterDays * DAY_MS).toISOString();
        dirty = true;
      }
      if (dirty) writeSchedule(d.stateRoot, schedule);
      if (entry.running) continue;
      const empty = loadKbRules(d.cfg, kb, { includeProposed: true }).rules.length === 0;
      const pass = duePass(entry, { now, rc, empty });
      if (pass) out.push(await requestPass(kb, pass, d));
    } catch (e) {
      d.log?.(`knowledge schedule error (${kb}): ${(e as Error).message}`);
    }
  }
  return out;
}

/** Close a pass: clear the lock, advance the cadence, and open the next window for changes that landed meanwhile. */
export function completePass(kb: string, d: { cfg: SquadrantConfig; stateRoot: string; now?: () => Date; pass?: PassKind }): PassKind {
  const now = d.now?.() ?? new Date();
  const schedule = readSchedule(d.stateRoot);
  const entry = (schedule[kb] ??= { createdAt: now.toISOString() });
  const pass = d.pass ?? entry.running?.pass ?? "incremental";
  const snap = entry.running?.sourceSnapshot;
  const root = kbDir(d.cfg, kb);
  delete entry.running;
  if (pass === "full") entry.lastFullAt = now.toISOString();
  delete entry.firstChangeAt;
  delete entry.incrementalDueAt;
  if (snap) {
    const nowSnap = snapshotSources(root, loadSources(root).sources);
    if (Object.entries(nowSnap).some(([ref, sha]) => snap[ref] !== sha)) {
      entry.firstChangeAt = now.toISOString();
      entry.incrementalDueAt = new Date(now.getTime() + reconcileConfig(d.cfg, kb).incrementalAfterDays * DAY_MS).toISOString();
    }
  }
  writeSchedule(d.stateRoot, schedule);
  return pass;
}
