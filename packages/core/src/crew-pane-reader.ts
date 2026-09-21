import { loadConfig } from "@squadrant/shared";
import type { PaneRef, RuntimeDriver, SquadrantConfig, TaskRecord } from "@squadrant/shared";
import type { DirectCmuxReader } from "./interfaces.js";
import type { PaneReadResult } from "./telegram/inbound-lifecycle.js";

const TAIL_LINES = 25;

// MUST match `titleFor` in src/commands/crew.ts — the crew tab title convention
// the daemon uses to find a crew's pane (🔧 <project>:<name>).
export function crewPaneTitle(project: string, name: string): string {
  return `🔧 ${project}:${name}`;
}

export type SurfaceLiveness = "alive" | "gone" | "unknown";

/**
 * Pure: decide an interactive crew's surface liveness from a resolved surface
 * list (#139). Three-valued so a transient cmux outage never false-reaps a live
 * crew — "gone" means PROVABLY absent, not "couldn't tell":
 *   - wantTitle null (crew has no name)            → "unknown"
 *   - surfaceTitles null (could not enumerate)     → "unknown"
 *   - title present in the list                    → "alive"
 *   - title absent from an enumerated list         → "gone"
 */
export function surfaceVerdict(surfaceTitles: string[] | null, wantTitle: string | null): SurfaceLiveness {
  if (!wantTitle) return "unknown";
  if (surfaceTitles == null) return "unknown";
  return surfaceTitles.includes(wantTitle) ? "alive" : "gone";
}

/**
 * I/O: enumerate the captain workspace's surface titles for a crew's project.
 * Returns null on ANY failure — surfaceVerdict maps null → "unknown" so we never
 * reap on an inconclusive probe. Never throws.
 */
async function listCaptainSurfaceTitles(
  rec: TaskRecord,
  makeRuntime: (project: string, config: SquadrantConfig) => RuntimeDriver | null,
): Promise<string[] | null> {
  try {
    const config = loadConfig();
    const proj = config.projects[rec.project];
    if (!proj) return null;
    const runtime = makeRuntime(rec.project, config);
    if (!runtime) return null;
    const captain = await runtime.status(proj.captainName);
    if (!captain) return null;
    const surfaces = await runtime.listSurfaces(captain.id);
    return surfaces.map((s) => s.title ?? "");
  } catch {
    return null;
  }
}

/**
 * Build the daemon's interactive surface-liveness probe (#139 backstop).
 * @param makeRuntime  Factory provided by the host (root package); omit for tests.
 */
export function createSurfaceLivenessProbe(
  makeRuntime?: (project: string, config: SquadrantConfig) => RuntimeDriver | null,
): (rec: TaskRecord) => Promise<SurfaceLiveness> {
  return async (rec) => {
    if (rec.mode !== "interactive" || !rec.name) return "unknown";
    if (!makeRuntime) return "unknown";
    const titles = await listCaptainSurfaceTitles(rec, makeRuntime);
    return surfaceVerdict(titles, crewPaneTitle(rec.project, rec.name));
  };
}

/**
 * Build the daemon's best-effort crew-pane reader (Phase 2b).
 * @param makeRuntime  Factory provided by the host; required for real pane reads.
 */
export function createCrewPaneReader(
  makeRuntime?: (project: string, config: SquadrantConfig) => RuntimeDriver | null,
): (rec: TaskRecord) => Promise<string | null> {
  return async (rec) => {
    try {
      if (!rec.name || !makeRuntime) return null;
      const config = loadConfig();
      const proj = config.projects[rec.project];
      if (!proj) return null;
      const runtime = makeRuntime(rec.project, config);
      if (!runtime) return null;
      const captain = await runtime.status(proj.captainName);
      if (!captain) return null;
      const surfaces = await runtime.listSurfaces(captain.id);
      const want = crewPaneTitle(rec.project, rec.name);
      const pane = surfaces.find((s) => s.title === want);
      if (!pane) return null;
      const screen = await runtime.readPaneScreen(pane);
      if (!screen) return null;
      return screen.split(/\r?\n/).slice(-TAIL_LINES).join("\n");
    } catch {
      return null;
    }
  };
}

/**
 * Build a direct surface-liveness probe for daemon-direct mode (#332).
 * Uses DirectCmuxReader (seam interface implemented by DaemonCmux in root).
 */
export function createDirectSurfaceLivenessProbe(
  cmux: DirectCmuxReader,
  getCaptainTitle: (project: string) => string,
): (rec: TaskRecord) => Promise<SurfaceLiveness> {
  return async (rec) => {
    try {
      if (rec.mode !== "interactive" || !rec.name) return "unknown";
      const wsId = await cmux.findWorkspaceId(getCaptainTitle(rec.project));
      if (!wsId) return "unknown";
      const surfaces = await cmux.listSurfaces(wsId);
      if (surfaces.length === 0) return "unknown";
      return surfaceVerdict(
        surfaces.map((s) => s.title ?? ""),
        crewPaneTitle(rec.project, rec.name),
      );
    } catch {
      return "unknown";
    }
  };
}

// ── #839: classify a SILENT captain from a real pane read ──────────────────
//
// The signature is deliberately mirrored from `hasModalOptionList` in
// @squadrant/workspaces (cmux.ts) rather than imported: the package DAG is
// one-way (core may not import workspaces), and this is a SCREEN-SHAPE question,
// not a runtime one. Both sides answer it the same way so a captain the pane
// layer would refuse to keystroke into is the same captain this calls LOCKED.
const HR_RE = /^\s*─{10,}\s*$/;

/** True when the HR-bounded region is an open AskUserQuestion/permission
 *  SELECTION MODAL (each selectable option renders as a `N. Label` line). */
export function hasModalOptionList(screen: string): boolean {
  if (!screen) return false;
  const lines = screen.split(/\r?\n/);
  let bottomHR = -1;
  let topHR = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HR_RE.test(lines[i])) {
      if (bottomHR === -1) bottomHR = i;
      else { topHR = i; break; }
    }
  }
  if (topHR === -1) return false;
  return lines.slice(topHR + 1, bottomHR).some((l) => /^\s*\d+\.\s/.test(l));
}

/** A live turn shows a spinner/counter. Mirrors the CC working-state heuristic
 *  in @squadrant/workspaces (cmux.ts CC_WORKING_RE) — same rationale as above. */
const WORKING_RE = /esc to interrupt|\btokens?\b.*\b(used|left)\b|↓\s*[\d.]+\s*k?\s*tokens?\b|\(\d+m?\s*\d+s\b/i;

/**
 * Pure: classify a captain's rendered pane for #839.
 *
 *   locked      — an open option/permission modal is up; a human must answer.
 *   mid-turn    — a turn is visibly in flight; slow, not stuck.
 *   no-session  — the pane rendered but shows no live agent session at all.
 *   unreadable  — we could not get a screen (null). NEVER reported as dead:
 *                 a probe we could not complete is the #834 false-negative class.
 *
 * `outputAgoMs` (time since the pane last changed) is used ONLY as the tiebreak
 * for `no-session`, which is the one genuinely-destructive verdict — and it is
 * REQUIRED for that verdict to be reachable at all: with it undefined, every
 * rendered pane with no modal and no visible turn reads `mid-turn`. A caller
 * that cannot supply it should not expect `no-session` from a live surface
 * (a missing workspace/pane is the other, independent path).
 */
export function classifyCaptainPane(
  screen: string | null,
  opts: { outputAgoMs?: number; idleAfterMs?: number } = {},
): PaneReadResult {
  if (screen == null || screen.trim() === "") return { status: "unreadable" };
  if (hasModalOptionList(screen)) return { status: "locked" };
  if (WORKING_RE.test(screen)) return { status: "mid-turn" };
  // No modal and no visible turn. Only call it dead when the pane has also been
  // stale past the idle threshold — otherwise a captain between turns (or one
  // mid-render) false-classifies as gone.
  const idleAfterMs = opts.idleAfterMs ?? 0;
  const stale = opts.outputAgoMs !== undefined && opts.outputAgoMs >= idleAfterMs;
  return stale ? { status: "no-session" } : { status: "mid-turn" };
}

/** Default pane-output staleness threshold: a captain whose screen has not moved
 *  for this long, with no visible turn, is not working. */
export const PANE_IDLE_AFTER_MS = 10 * 60_000;

/** Cheap stable digest of a pane screen (FNV-1a). Not cryptographic — it only has
 *  to answer "did this screen change since the last poll". */
export function screenHash(screen: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < screen.length; i++) {
    h ^= screen.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Build the #839 captain-pane classifier for the Telegram watchdog. Reads the
 * CAPTAIN's own surface (not a crew's) and classifies it.
 *
 * cmux exposes NO pane activity timestamp (`PaneRef` is id+s­title, and
 * `listSurfaces` reads a tree without mtimes), so staleness is measured HERE by
 * tracking the screen hash across the watchdog's own polls. Without this the
 * `outputAgoMs` tiebreak in classifyCaptainPane would never be real: every
 * rendered-but-dead pane would read "mid-turn (working)" — the false-comfort
 * class #839 exists to kill.
 *
 * @param getCaptainTitle  Resolves a project's captain workspace/surface title.
 * @param cmux  DirectCmuxReader (seam implemented by DaemonCmux in root).
 * @param noteScreen  Records the screen hash and returns ms since it last
 *                    CHANGED (undefined on first sight of a screen). Injected so
 *                    the watchdog's persisted store owns the clock across restarts.
 */
export function createCaptainPaneReader(
  cmux: DirectCmuxReader,
  getCaptainTitle: (project: string) => string,
  opts: {
    log?: (msg: string) => void;
    noteScreen?: (project: string, hash: string) => number | undefined;
    idleAfterMs?: number;
  } = {},
): (project: string) => Promise<PaneReadResult> {
  const idleAfterMs = opts.idleAfterMs ?? PANE_IDLE_AFTER_MS;
  return async (project) => {
    try {
      const wsId = await cmux.findWorkspaceId(getCaptainTitle(project));
      if (!wsId) return { status: "no-session" };
      const surfaces = await cmux.listSurfaces(wsId);
      const want = getCaptainTitle(project);
      const pane: PaneRef | undefined =
        surfaces.find((s) => s.title === want) ?? surfaces[0];
      if (!pane) return { status: "no-session" };
      const screen = await cmux.readPaneScreen(pane);
      if (screen == null) return { status: "unreadable" };
      // The stale-output tiebreak only applies to the ambiguous case: a rendered
      // pane with no modal and no visible turn. locked/mid-turn short-circuit
      // inside classifyCaptainPane, so hashing costs nothing for them.
      const outputAgoMs = opts.noteScreen?.(project, screenHash(screen));
      return classifyCaptainPane(screen, { outputAgoMs, idleAfterMs });
    } catch (e) {
      // A cmux outage must never be read as a dead captain (#834).
      opts.log?.(`captain pane read failed project=${project}: ${(e as Error).message}`);
      return { status: "unreadable" };
    }
  };
}

/**
 * Build a direct crew-pane reader for daemon-direct mode (#332).
 * Uses DirectCmuxReader (seam interface implemented by DaemonCmux in root).
 */
export function createDirectCrewPaneReader(
  cmux: DirectCmuxReader,
  getCaptainTitle: (project: string) => string,
): (rec: TaskRecord) => Promise<string | null> {
  return async (rec) => {
    try {
      if (!rec.name) return null;
      const wsId = await cmux.findWorkspaceId(getCaptainTitle(rec.project));
      if (!wsId) return null;
      const surfaces = await cmux.listSurfaces(wsId);
      const want = crewPaneTitle(rec.project, rec.name);
      const pane = surfaces.find((s) => s.title === want);
      if (!pane) return null;
      const screen = await cmux.readPaneScreen(pane);
      if (!screen) return null;
      return screen.split(/\r?\n/).slice(-TAIL_LINES).join("\n");
    } catch {
      return null;
    }
  };
}
