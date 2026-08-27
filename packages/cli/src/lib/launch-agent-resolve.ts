import type { ThinkingLevel } from "@squadrant/shared";

// #627 item A: resolve a launch role's agent/model with the same
// explicit-flag-always-wins precedence crew spawn already uses (#275:
// `input.model ?? route?.model ?? configModel`) — an explicit CLI flag beats
// config, config beats the built-in default.

export interface RoleAgentConfig {
  agent?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export function resolveLaunchAgent(
  overrides: { agent?: string; model?: string; thinking?: ThinkingLevel },
  roleConfig: RoleAgentConfig | undefined,
  roleModelDefault: string | undefined,
): { agentName: string; model: string | undefined; thinking: ThinkingLevel | undefined } {
  return {
    agentName: overrides.agent ?? roleConfig?.agent ?? "claude",
    model: overrides.model ?? roleConfig?.model ?? roleModelDefault,
    // No built-in default: unset ⇒ flag omitted ⇒ the agent's own effort.
    thinking: overrides.thinking ?? roleConfig?.thinking,
  };
}
