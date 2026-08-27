import type { ThinkingLevel } from "@squadrant/shared";

export type AgentCapability =
  | "teams"
  | "json_output"
  | "sandbox"
  | "model_routing"
  | "skills"
  | "auto_approve"
  | "streaming"
  | "prompt_file"
  // #667: runtime control over the agent's own native API. Tiered, NOT reduced to
  // the intersection of the two agents — designing to the common denominator would
  // discard opencode's most valuable endpoints.
  | "control_send"      // T0 — deliver a message into a live session
  | "control_observe"   // T1 — read liveness / status
  | "control_interact"; // T2 — approvals, questions, interrupt (opencode only)

export type Role = "command" | "captain" | "crew" | "exploration" | "side";

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
  // Per-role thinking level → claude's `--effort <level>`. Only the claude
  // driver reads this; no other agent CLI accepts the flag. Absent ⇒ flag
  // omitted ⇒ the agent's own default effort.
  thinking?: ThinkingLevel;
  autoApprove?: boolean;
  jsonOutput?: boolean;
  promptFile?: string;
  // Claude's --permission-mode value (e.g. "acceptEdits", "plan", "default").
  // "acceptEdits" auto-accepts file edits while still prompting for risky ops
  // (Bash, etc.) — the semi-automatic gate used for cheaper-model crews. If
  // autoApprove is also set, --dangerously-skip-permissions supersedes this.
  permissionMode?: string;
  // Interactive crew sessions: drivers should NOT bake the prompt into the
  // command (no `-p`). Caller will deliver the prompt via runtime.send after
  // the CLI is ready, so the session stays alive between turns.
  interactive?: boolean;
  // TCP port for an agent's embedded HTTP server. Opencode interactive crews
  // launch as `opencode --port <N>` so the daemon's SSE bridge can subscribe
  // to the crew's /event stream for reliable turn-end detection.
  port?: number;
  // #667 slice 3: claude's UDS session inbox path. Naming it at spawn is what
  // lets the daemon address the session without reverse-engineering the
  // pid-derived default. Absent ⇒ flag omitted ⇒ no behaviour change.
  messagingSocketPath?: string;
  // #708: claude's `-n, --name` flag. Absent ⇒ flag omitted ⇒ Claude Code
  // falls back to its own cwd-derived default, same as today. Only the claude
  // driver reads this — other drivers ignore it, `-n` is claude-only.
  sessionName?: string;
  // Per-invocation settings file (Claude's --settings flag). The
  // daemon-supervised claude crew spawn writes a per-crew settings.json
  // containing the squadrant Stop hook and passes the path here so the hook
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
  exploration: { required: ["auto_approve"], preferred: [] },
  side:        { required: ["auto_approve"], preferred: ["skills"] },
};
