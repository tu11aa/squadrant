import type { BackendMode, SquadrantConfig } from "@squadrant/shared";

export interface CrewRouteResult {
  agent: string;
  model?: string;
  backend?: BackendMode;
  tier: string;
  matchedRule: string;
}

/**
 * Resolve a crew route from task text against config.defaults.crewRouting.rules.
 * Returns the first matching rule's agent/model/backend, or null if no rule
 * matches or crewRouting is absent. Pure — no side effects.
 */
export function resolveCrewRoute(taskText: string, config: SquadrantConfig): CrewRouteResult | null {
  const rules = config.defaults.crewRouting?.rules;
  if (!rules || rules.length === 0) return null;
  for (const rule of rules) {
    const re = new RegExp(rule.match, "i");
    if (re.test(taskText)) {
      return {
        agent: rule.agent,
        ...(rule.model !== undefined ? { model: rule.model } : {}),
        ...(rule.backend !== undefined ? { backend: rule.backend } : {}),
        tier: rule.tier,
        matchedRule: rule.match,
      };
    }
  }
  return null;
}
