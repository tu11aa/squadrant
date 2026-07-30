// #627 item B: a non-Claude fallback (opencode/codex/gemini) that still
// resolves to an Anthropic model depends on exactly the provider it exists to
// route around. isAnthropicModel lets callers detect that before it becomes a
// silent trap during an actual Anthropic outage.

const ANTHROPIC_MODEL_PREFIX = "anthropic/";

export function isAnthropicModel(model: string | undefined): boolean {
  return !!model && model.startsWith(ANTHROPIC_MODEL_PREFIX);
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
