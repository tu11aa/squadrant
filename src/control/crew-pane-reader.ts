import { loadConfig } from "@cockpit/shared";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import type { DaemonCmux } from "./cmux/daemon-cmux.js";
import type { TaskRecord } from "@cockpit/shared";

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
 * I/O: enumerate the captain workspace's surface titles for a crew's project,
 * the same way the pane reader does. Returns null on ANY failure (cmux down, no
 * captain, no project) — surfaceVerdict maps null → "unknown" so we never reap
 * on an inconclusive probe. Never throws (the daemon sweep must not trip).
 */
async function listCaptainSurfaceTitles(rec: TaskRecord): Promise<string[] | null> {
  try {
    const config = loadConfig();
    const proj = config.projects[rec.project];
    if (!proj) return null;
    const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(rec.project, config);
    const captain = await runtime.status(proj.captainName);
    if (!captain) return null;
    const surfaces = await runtime.listSurfaces(captain.id);
    return surfaces.map((s) => s.title ?? "");
  } catch {
    return null;
  }
}

/**
 * Build the daemon's interactive surface-liveness probe (#139 backstop). Wired
 * into createDaemon as `isSurfaceAlive`: the sweep/reconcile reaper terminalizes
 * a non-terminal interactive record whose pane is provably gone. Non-interactive
 * or unnamed records short-circuit to "unknown" (never reaped).
 */
export function createSurfaceLivenessProbe(): (rec: TaskRecord) => Promise<SurfaceLiveness> {
  return async (rec) => {
    if (rec.mode !== "interactive" || !rec.name) return "unknown";
    const titles = await listCaptainSurfaceTitles(rec);
    return surfaceVerdict(titles, crewPaneTitle(rec.project, rec.name));
  };
}

/**
 * Build the daemon's best-effort crew-pane reader (Phase 2b). Resolves the
 * crew's cmux pane the same way `cockpit crew read` does — captain workspace →
 * surfaces → the crew tab by title — and returns the LAST ~25 lines of its
 * screen. Returns null on ANY failure (cmux down, no captain, pane gone, no
 * name) and NEVER throws, so the probe loop can't take the daemon down.
 */
export function createCrewPaneReader(): (rec: TaskRecord) => Promise<string | null> {
  return async (rec) => {
    try {
      if (!rec.name) return null;
      const config = loadConfig();
      const proj = config.projects[rec.project];
      if (!proj) return null;
      const runtime = new RuntimeRegistry({ cmux: createCmuxDriver() }).forProject(rec.project, config);
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
 * Uses DaemonCmux to list surfaces directly (bypassing the relay/proxy).
 * Fail-soft: `listSurfaces` returning `[]` (error or empty) → "unknown"
 * so a transient cmux outage never false-reaps a live crew. Non-empty list
 * without the wanted pane → "gone". Never throws.
 */
export function createDirectSurfaceLivenessProbe(
  cmux: DaemonCmux,
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

/**
 * Build a direct crew-pane reader for daemon-direct mode (#332).
 * Uses DaemonCmux.readScreen directly instead of the RuntimeRegistry path
 * (which relies on relay-proxy). Returns the last ~25 lines of the crew's
 * cmux pane, or null on any failure. Never throws.
 */
export function createDirectCrewPaneReader(
  cmux: DaemonCmux,
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
