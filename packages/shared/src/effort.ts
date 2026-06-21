import type { SquadrantConfig } from "./config.js";

export type Effort = "max" | "balance" | "low";

export function resolveEffort(config: SquadrantConfig): Effort {
  return config.defaults.effort ?? "balance";
}
