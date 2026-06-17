import { loadConfig } from "@cockpit/shared";
import type { RuntimeDriver, CockpitConfig, TaskRecord } from "@cockpit/shared";
import type { DirectCmuxReader } from "./interfaces.js";

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
  makeRuntime: (project: string, config: CockpitConfig) => RuntimeDriver | null,
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
  makeRuntime?: (project: string, config: CockpitConfig) => RuntimeDriver | null,
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
  makeRuntime?: (project: string, config: CockpitConfig) => RuntimeDriver | null,
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
