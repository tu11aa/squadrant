import type { BackendMode, ThinkingLevel } from "@squadrant/shared";

// #627 item A: resolve a launch role's agent/model with the same
// explicit-flag-always-wins precedence crew spawn already uses (#275:
// `input.model ?? route?.model ?? configModel`) — an explicit CLI flag beats
// config, config beats the built-in default.

export interface RoleAgentConfig {
  agent?: string;
  model?: string;
  thinking?: ThinkingLevel;
  /** U2 backend seam. `direct`/`proxy` are claude-only. Unset ⇒ native. */
  backend?: BackendMode;
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

/**
 * #772: resolve a captain launch's backend with the same precedence crew spawn
 * uses (explicit flag > role default > native). The role backend only applies
 * when the resolved agent is claude — `direct`/`proxy` speak the Anthropic
 * Messages seam and are claude-only; a non-claude captain must stay native
 * rather than trip the claude-only guard on an unset/irrelevant role backend.
 */
export function resolveLaunchBackend(o: {
  backendOverride?: BackendMode;
  agentName: string;
  roleConfig: RoleAgentConfig | undefined;
}): BackendMode {
  const roleBackend = o.agentName === "claude" ? o.roleConfig?.backend : undefined;
  return o.backendOverride ?? roleBackend ?? "native";
}
