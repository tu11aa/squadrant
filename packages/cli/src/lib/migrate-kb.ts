// migrate-kb.ts — #983 6b: `squadrant migrate kb`, the KB spec §10 path moves
// (docs/specs/2026-10-10-knowledge-base-architecture-design.md). Same contract
// as #936's `knowledge migrate`, which it folds in: dry-run, move, never
// delete, print a report, idempotent. Directories are merged file by file and
// an existing target file is never overwritten, because captains on this
// version already write to the workspace before the operator migrates.
import fs from "node:fs";
import path from "node:path";
import {
  resolveHome, workspacePath, archiveRoot, legacyStateDir, stateRoot, stateSeedMarkerPath, type SquadrantConfig,
} from "@squadrant/shared";
import { moveLegacyKbs, moveLegacyOverlays, loadedDaemonLogPath, LABEL, type KbMoveEntry } from "@squadrant/core";
import { moveMap, refSites, sweepRefs, type RefHit } from "./ref-sweep.js";

export interface MigrateKbEntry extends Omit<KbMoveEntry, "action"> {
  action: KbMoveEntry["action"] | "would-archive" | "archived";
}

export interface MigrateKbOpts {
  dryRun?: boolean;
  /** Pre-#983 config dir holding the legacy `state/` and `squadrantd.log`. Default: dirname(legacyStateDir()). */
  configDir?: string;
  /** Current state root; its seed marker gates archiving the legacy state. Default: stateRoot(). */
  stateRoot?: string;
  /** The log path launchd currently writes (null: not loaded). Default: `launchctl print`. */
  launchdLogPath?: () => string | null;
  /** Archive subdir name, YYYY-MM-DD. Default: today. */
  today?: string;
}

/** Spoke subdirs that are exchange (same name in the workspace). */
const EXCHANGE_DIRS = ["handoffs", "side-handoffs"];
/** Spoke subdirs that become workspace/<p>/artifacts/<kind>/ (dated, immutable). */
const ARTIFACT_DIRS = ["reports", "research", "findings", "recaps", "plans", "daily-logs"];
/** Files an Obsidian scaffold puts in an otherwise empty wiki/learnings dir. */
const SCAFFOLD_FILES = new Set(["index.md", "log.md", ".gitkeep"]);

/** Every regular file under dir, relative to it. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return filesUnder(path.join(dir, e.name)).map((f) => path.join(e.name, f));
    return e.isFile() ? [e.name] : [];
  });
}

const plural = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/** rename, or copy across devices (the original then stays: never delete). Returns whether it copied. */
function moveFile(from: string, to: string): boolean {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    fs.copyFileSync(from, to);
    return true;
  }
}

const CROSS_DEVICE = "cross-device: original left in place, delete it yourself once verified";

/** One file. Never overwrites: an existing target is reported and left alone. */
function transferFile(kb: string, from: string, to: string, archive: boolean, dryRun: boolean): MigrateKbEntry[] {
  if (!fs.existsSync(from)) return [];
  if (fs.existsSync(to)) return [{ kb, from, to, action: "skipped", note: "target exists; left in place" }];
  if (dryRun) return [{ kb, from, to, action: archive ? "would-archive" : "would-move" }];
  if (moveFile(from, to)) return [{ kb, from, to, action: "copied", note: CROSS_DEVICE }];
  return [{ kb, from, to, action: archive ? "archived" : "moved" }];
}

/** `rels` (paths relative to fromDir) merged into toDir: one row for the batch, one `skipped` row per clashing file. */
function transferFiles(kb: string, fromDir: string, toDir: string, rels: string[], archive: boolean, dryRun: boolean): MigrateKbEntry[] {
  const skipped: MigrateKbEntry[] = [];
  const movable = rels.filter((rel) => {
    const to = path.join(toDir, rel);
    if (!fs.existsSync(to)) return true;
    skipped.push({ kb, from: path.join(fromDir, rel), to, action: "skipped", note: "target exists; left in place" });
    return false;
  });
  if (!movable.length) return skipped;
  const row = { kb, from: fromDir, to: toDir, note: plural(movable.length) };
  if (dryRun) return [{ ...row, action: archive ? "would-archive" : "would-move" }, ...skipped];
  let copied = false;
  for (const rel of movable) copied = moveFile(path.join(fromDir, rel), path.join(toDir, rel)) || copied;
  if (copied) return [{ ...row, action: "copied", note: `${row.note}; ${CROSS_DEVICE}` }, ...skipped];
  return [{ ...row, action: archive ? "archived" : "moved" }, ...skipped];
}

/** A whole dir, merged file by file. */
function transferDir(kb: string, from: string, to: string, archive: boolean, dryRun: boolean): MigrateKbEntry[] {
  return transferFiles(kb, from, to, filesUnder(from), archive, dryRun);
}

/** Spoke `captain-sessions.jsonl`: when the workspace already has one, merge the lines in and archive the original. */
function migrateRegistry(kb: string, from: string, to: string, archived: string, dryRun: boolean): MigrateKbEntry[] {
  if (!fs.existsSync(from)) return [];
  if (!fs.existsSync(to)) return transferFile(kb, from, to, false, dryRun);
  const note = `merge into the existing registry; original archived at ${archived}`;
  if (dryRun) return [{ kb, from, to, action: "would-move", note }];
  if (fs.existsSync(archived)) return [{ kb, from, to, action: "skipped", note: `archive copy already exists at ${archived}` }];
  const old = fs.readFileSync(from, "utf-8");
  fs.appendFileSync(to, old.endsWith("\n") || !old ? old : old + "\n");
  moveFile(from, archived);
  return [{ kb, from, to, action: "moved", note: note.replace("merge", "merged") }];
}

function archiveLegacyState(opts: MigrateKbOpts, to: string, dryRun: boolean): MigrateKbEntry[] {
  const configDir = opts.configDir ?? path.dirname(legacyStateDir());
  const root = opts.stateRoot ?? stateRoot();
  const legacyState = path.join(configDir, "state");
  const legacyLog = path.join(configDir, "squadrantd.log");
  if (path.resolve(legacyState) === path.resolve(root)) return []; // isolated SQUADRANT_CONFIG: it IS the live state
  const hasState = filesUnder(legacyState).length > 0;
  const hasLog = fs.existsSync(legacyLog);
  if (!hasState && !hasLog) return [];
  if (!fs.existsSync(stateSeedMarkerPath(root))) {
    return [{
      kb: "state", from: legacyState, to, action: "skipped",
      note: `not seeded yet: the upgraded daemon copies it into ${root} on its next boot; re-run after that (nothing moved)`,
    }];
  }
  const rows = transferDir("state", legacyState, path.join(to, "state"), true, dryRun);
  if (hasLog) {
    const launchdLog = (opts.launchdLogPath ?? (() => loadedDaemonLogPath(`gui/${process.getuid?.() ?? 0}/${LABEL}`)))();
    if (launchdLog !== null && path.resolve(launchdLog) === path.resolve(legacyLog)) {
      rows.push({ kb: "state", from: legacyLog, to: "", action: "skipped", note: "launchd still writes it: run squadrant heal daemon first" });
    } else {
      rows.push(...transferFile("state", legacyLog, path.join(to, "squadrantd.log"), true, dryRun));
    }
  }
  return rows;
}

export function migrateKb(cfg: SquadrantConfig, opts: MigrateKbOpts = {}): MigrateKbEntry[] {
  const dryRun = !!opts.dryRun;
  const day = path.join(archiveRoot(), opts.today ?? new Date().toISOString().slice(0, 10));
  const rows: MigrateKbEntry[] = [];

  // 1. spokes -> workspace (exchange) and workspace/artifacts
  for (const [project, proj] of Object.entries(cfg.projects ?? {})) {
    if (!proj.spokeVault) continue;
    const spoke = resolveHome(proj.spokeVault);
    const ws = workspacePath(project);
    if (spoke === ws) continue;
    const kb = `workspace:${project}`;
    rows.push(...transferFile(kb, path.join(spoke, "handoff.json"), path.join(ws, "handoff.json"), false, dryRun));
    rows.push(...migrateRegistry(kb, path.join(spoke, "captain-sessions.jsonl"), path.join(ws, "captain-sessions.jsonl"),
      path.join(day, "spokes", project, "captain-sessions.jsonl"), dryRun));
    for (const d of EXCHANGE_DIRS) rows.push(...transferDir(kb, path.join(spoke, d), path.join(ws, d), false, dryRun));
    for (const d of ARTIFACT_DIRS) rows.push(...transferDir(kb, path.join(spoke, d), path.join(ws, "artifacts", d), false, dryRun));
    rows.push(...transferDir(kb, path.join(spoke, "artifacts"), path.join(ws, "artifacts"), false, dryRun));
  }

  // 2. retired hub files -> archive/<date>/hub/
  if (cfg.hubVault) {
    const hub = resolveHome(cfg.hubVault);
    const to = path.join(day, "hub");
    rows.push(...transferFile("archive", path.join(hub, "CLAUDE.md"), path.join(to, "CLAUDE.md"), true, dryRun));
    const projects = path.join(hub, "projects");
    const md = fs.existsSync(projects) ? fs.readdirSync(projects).filter((f) => f.endsWith(".md") && fs.statSync(path.join(projects, f)).isFile()) : [];
    rows.push(...transferFiles("archive", projects, path.join(to, "projects"), md, true, dryRun));
    rows.push(...transferDir("archive", path.join(hub, "daily-logs"), path.join(to, "daily-logs"), true, dryRun));
    for (const d of ["wiki", "learnings"]) {
      const files = filesUnder(path.join(hub, d));
      if (!files.length) continue;
      if (files.every((f) => SCAFFOLD_FILES.has(path.basename(f)))) rows.push(...transferDir("archive", path.join(hub, d), path.join(to, d), true, dryRun));
      else rows.push({ kb: "archive", from: path.join(hub, d), to: "", action: "skipped", note: "has content; KB phase 4b routes it" });
    }
  }

  // 3. legacy ~/.config state + daemon log -> archive/<date>/config/ (#983 6a). The daemon itself
  //    copies the legacy state into stateRoot() on boot (seed marker); only after that is the
  //    legacy copy archive material. Not seeded yet: skip, never move live state.
  rows.push(...archiveLegacyState(opts, path.join(day, "config"), dryRun));

  // 4. #936 knowledge migrate (KBs first: an overlay target may live inside a KB that was just moved)
  rows.push(...moveLegacyKbs(cfg, { dryRun }), ...moveLegacyOverlays(cfg, { dryRun }));
  return rows;
}

/**
 * #998 `squadrant migrate path <from> <to>`: move an operator-made file or dir with the same rules
 * (merged file by file, never overwrites, `skipped` rows), then sweep every reference to it. With
 * <from> already gone and <to> present, only the references are rewritten.
 */
export function migratePath(
  cfg: SquadrantConfig, fromArg: string, toArg: string, opts: { dryRun?: boolean; home?: string; today?: string } = {},
): { rows: MigrateKbEntry[]; refs: RefHit[] } {
  const from = path.resolve(resolveHome(fromArg));
  const to = path.resolve(resolveHome(toArg));
  if (from === to || to.startsWith(from + path.sep)) throw new Error(`${to} is ${from} or inside it`);
  const dryRun = !!opts.dryRun;
  let rows: MigrateKbEntry[] = [];
  if (fs.existsSync(from)) {
    rows = fs.statSync(from).isDirectory() ? transferDir("path", from, to, false, dryRun) : transferFile("path", from, to, false, dryRun);
  } else if (!fs.existsSync(to)) {
    throw new Error(`neither ${from} nor ${to} exists`);
  }
  const map = moveMap(rows);
  // every file skipped: nothing moved, so references to <from> still resolve
  if (!map.has(from) && !(rows.length && rows.every((r) => r.action === "skipped"))) map.set(from, to);
  return { rows, refs: sweepRefs(map, refSites(cfg, opts.home), opts) };
}
