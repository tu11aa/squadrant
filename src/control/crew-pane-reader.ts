import { loadConfig } from "../config.js";
import { createCmuxDriver, RuntimeRegistry } from "../runtimes/index.js";
import type { TaskRecord } from "./types.js";

const TAIL_LINES = 25;

// MUST match `titleFor` in src/commands/crew.ts — the crew tab title convention
// the daemon uses to find a crew's pane (🔧 <project>:<name>).
function crewPaneTitle(project: string, name: string): string {
  return `🔧 ${project}:${name}`;
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
