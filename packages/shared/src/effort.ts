import type { CockpitConfig } from "./config.js";

export type Effort = "max" | "balance" | "low";

export function resolveEffort(config: CockpitConfig): Effort {
  return config.defaults.effort ?? "balance";
}
