// Live config reload (`config-reload` request): re-read config and reconcile the
// few project-derived structures the daemon built at boot. Everything else that
// reads the project registry already calls loadConfig() on demand, so a newly
// registered project is visible to health/snapshot/delivery with no further work.
import { loadConfig, type SquadrantConfig } from "@squadrant/shared";
import type { DaemonContext } from "./context.js";

export interface ConfigReloadResult {
  projects: string[];
  /** Projects whose router token was minted by this reload. */
  routerAdded: string[];
}

export function reloadDaemonConfig(
  ctx: Pick<DaemonContext, "routerService" | "log">,
  load: () => SquadrantConfig = loadConfig,
): ConfigReloadResult {
  const projects = Object.keys(load().projects);
  const routerAdded = ctx.routerService?.syncProjects(projects) ?? [];
  ctx.log(`config reload: ${projects.length} project(s)${routerAdded.length ? `, router tokens added for ${routerAdded.join(",")}` : ""}`);
  return { projects, routerAdded };
}
