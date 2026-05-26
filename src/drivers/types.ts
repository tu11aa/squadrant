export type AgentCapability =
  | "teams"
  | "json_output"
  | "sandbox"
  | "model_routing"
  | "skills"
  | "auto_approve"
  | "streaming"
  | "prompt_file";

export type Role = "command" | "captain" | "crew" | "reactor" | "exploration";

export interface AgentProbeResult {
  installed: boolean;
  version: string;
  capabilities: AgentCapability[];
}

export interface SpawnOptions {
  prompt: string;
  workdir: string;
  role: Role;
  model?: string;
  autoApprove?: boolean;
  jsonOutput?: boolean;
  promptFile?: string;
  // Interactive crew sessions: drivers should NOT bake the prompt into the
  // command (no `-p`). Caller will deliver the prompt via runtime.send after
  // the CLI is ready, so the session stays alive between turns.
  interactive?: boolean;
  // Per-invocation settings file (Claude's --settings flag). The
  // daemon-supervised claude crew spawn writes a per-crew settings.json
  // containing the cockpit Stop hook and passes the path here so the hook
  // is scoped to this session only (no global ~/.claude/settings.json edit).
  settingsPath?: string;
}

export interface AgentResult {
  status: "success" | "error" | "timeout";
  output: string;
  filesChanged?: string[];
}

export interface AgentDriver {
  name: string;
  templateSuffix: string;

  probe(): Promise<AgentProbeResult>;
  buildCommand(opts: SpawnOptions): string;
  parseOutput(raw: string): AgentResult;
  stop(pid: number): Promise<void>;
}

export interface RoleRequirements {
  required: AgentCapability[];
  preferred: AgentCapability[];
}

export const ROLE_REQUIREMENTS: Record<Role, RoleRequirements> = {
  command:     { required: ["auto_approve"], preferred: ["teams", "json_output"] },
  captain:     { required: ["auto_approve"], preferred: ["teams", "model_routing", "skills"] },
  crew:        { required: ["auto_approve"], preferred: ["json_output", "sandbox"] },
  reactor:     { required: ["auto_approve", "json_output"], preferred: [] },
  exploration: { required: ["auto_approve"], preferred: [] },
};
