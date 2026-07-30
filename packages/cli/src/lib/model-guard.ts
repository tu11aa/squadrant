// #627 item B: a non-Claude fallback (opencode/codex/gemini) that still
// resolves to an Anthropic model depends on exactly the provider it exists to
// route around. isAnthropicModel lets callers detect that before it becomes a
// silent trap during an actual Anthropic outage.

const ANTHROPIC_MODEL_PREFIX = "anthropic/";
// Anthropic models are also addressed without the "anthropic/" provider
// prefix in plenty of configs (bare `claude-sonnet-4-5`, `claude-opus-4-8`,
// …) — the prefix form is what the provisioned opencode default happens to
// use, but it isn't the only way to name an Anthropic model. Recognize the
// obvious bare form too rather than only the one concrete trap we know about.
const BARE_CLAUDE_MODEL_PREFIX = "claude-";

export function isAnthropicModel(model: string | undefined): boolean {
  return !!model && (model.startsWith(ANTHROPIC_MODEL_PREFIX) || model.startsWith(BARE_CLAUDE_MODEL_PREFIX));
}

export function anthropicFallbackMessage(agentName: string, model: string): string {
  return (
    `${agentName} resolved to Anthropic model '${model}'. A ${agentName} fallback that ` +
    "still depends on Anthropic can't survive the outage manual mode exists for. " +
    "Pass --model with a non-Anthropic model."
  );
}

/** True when `agentName` is a non-Claude fallback that resolved to an Anthropic
 *  model — claude itself is exempt, since depending on Anthropic is expected there. */
export function isBlockedFallback(agentName: string, model: string | undefined): boolean {
  return agentName !== "claude" && isAnthropicModel(model);
}

/** Message for a refused launch. Deliberately takes `role` as a plain
 *  parameter with no per-role branching — see the role-scope note in
 *  launch.ts: the guard is role-agnostic by design, not narrowed to captain. */
export function anthropicRefusalMessage(role: string, workspaceName: string, agentName: string, model: string): string {
  return `Refusing to launch ${role} '${workspaceName}' on ${agentName}: ${anthropicFallbackMessage(agentName, model)}`;
}
