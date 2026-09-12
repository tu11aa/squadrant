import type { RouterConfig } from "./config.js";

/**
 * Resolve a configured model id for a specific harness. If `model` names an alias
 * in `router.models`, return the per-agent id when present, else the upstream id.
 * Any other value is a literal and passes through unchanged (backward compatible).
 */
export function resolveRouterModel(
  model: string | undefined,
  agentName: string,
  router: RouterConfig | undefined,
): string | undefined {
  if (!model) return undefined;
  const alias = router?.models?.[model];
  if (!alias) return model;
  return alias.agents?.[agentName] ?? alias.upstream;
}
