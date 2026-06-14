import type { CockpitConfig } from "../config.js";

export interface CrewRouteResult {
  agent: string;
  model?: string;
  tier: string;
  matchedRule: string;
}

/**
 * Resolve a crew route from task text against config.defaults.crewRouting.rules.
 * Returns the first matching rule's agent/model, or null if no rule matches or
 * crewRouting is absent. Pure — no side effects.
 */
export function resolveCrewRoute(taskText: string, config: CockpitConfig): CrewRouteResult | null {
  const rules = config.defaults.crewRouting?.rules;
  if (!rules || rules.length === 0) return null;
  for (const rule of rules) {
    const re = new RegExp(rule.match, "i");
    if (re.test(taskText)) {
      return {
        agent: rule.agent,
        ...(rule.model !== undefined ? { model: rule.model } : {}),
        tier: rule.tier,
        matchedRule: rule.match,
      };
    }
  }
  return null;
}
