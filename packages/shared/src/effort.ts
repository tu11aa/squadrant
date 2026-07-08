import type { SquadrantConfig } from "./config.js";
import { loadProjectOverride } from "./project-config.js";

export type Effort = "max" | "balance" | "low";

export function resolveEffort(
  config: SquadrantConfig,
  projectName?: string,
  projectConfigRoot?: string,
): Effort {
  if (projectName) {
    const override = loadProjectOverride(projectName, projectConfigRoot);
    return override.effort ?? config.defaults.effort ?? "balance";
  }
  return config.defaults.effort ?? "balance";
}
