// src/config.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";

export interface ProjectConfig {
  path: string;
  captainName: string;
  spokeVault: string;
  host: string;
  group?: string;
  groupRole?: string;
  runtime?: string;
  workspace?: string;
  /** #246: when false, `cockpit group dispatch` rejects delegations to this
   *  project. Defaults to true when absent. */
  acceptDelegations?: boolean;
}

export interface PermissionConfig {
  command: string;   // permission mode for the command session
  captain: string;   // permission mode for captain sessions
  crew?: string;     // permission mode for crew sessions (default: acceptEdits)
  // Flexible role->mode map so future roles don't need a type change.
  [role: string]: string | undefined;
}

export type ModelAlias = "opus" | "sonnet" | "haiku";

export interface CrewRoutingRule {
  tier: string;
  match: string;
  agent: string;
  model?: string;
}

export interface CrewRoutingConfig {
  rules: CrewRoutingRule[];
}

export interface ModelRoutingConfig {
  command: ModelAlias;
  captain: ModelAlias;
  crew: ModelAlias;
  exploration: ModelAlias;
  review: ModelAlias;
}

export interface AgentEntry {
  cli: string;
  driver: string;
}

export interface RoleAssignment {
  agent: string;
  model?: string;
}

export type RoleConfig = Partial<Record<"command" | "captain" | "crew" | "exploration" | "side", RoleAssignment>>;

export interface CockpitConfig {
  /** Package version that last reconciled this config. Absent on legacy/fresh configs. */
  _cockpitVersion?: string;
  commandName: string;
  hubVault: string;
  projects: Record<string, ProjectConfig>;
  agents?: Record<string, AgentEntry>;
  runtime?: string;
  workspace?: string;
  notifier?: string;
  projection?: {
    targets?: string[];
  };
  relay?: {
    /** Max consecutive defers before force-delivering a message (~1s poll cadence). Default: 300 (~5min). */
    maxDeferDeliveries?: number;
    /** Consecutive stable-content polls before probing early to avoid a stall (#302). Default: 3 (~3s). */
    stableProbePolls?: number;
  };
  defaults: {
    maxCrew: number;
    worktreeDir: string;
    teammateMode: string;
    permissions: PermissionConfig;
    models?: ModelRoutingConfig;
    roles?: RoleConfig;
    /** #225 hard crew task-timeout ceiling (ms). Default: 8h. */
    taskTimeoutMs?: number;
    /** #275 rule-based crew routing: keyword rules map task text to {agent, model}. Optional — absent = fall through to defaults.roles.crew. */
    crewRouting?: CrewRoutingConfig;
    /** B1: consume cmux's native event stream for crew turn-end (idle) detection
     *  alongside the scrape fallback. Default true; set false for scrape-only. */
    cmuxEventsBridge?: boolean;
    /** #332: daemon calls cmux directly (bypass notify-relay).
     *  TRANSPORT ONLY — does not change lifecycle source-of-truth.
     *  Default false for safe rollout; set true to retire the relay process. */
    daemonDirectCmux?: boolean;
    /**
     * Audit C2 — agent hibernation (reclaim idle-crew RAM). INTENTIONALLY OFF and
     * INERT: cmux 0.64.16's `cmux agent-hibernation <on|off>` is GLOBAL (app-wide,
     * no per-session/per-workspace scope), so enabling it would also hibernate the
     * CAPTAIN and the notify-relay — both must stay responsive to deliver
     * notifications — breaking orchestration. We do NOT call `agent-hibernation on`
     * anywhere; this flag is a documented decision record + a forward hook for when
     * cmux gains crew-only scoping. Until then leave false.
     * See docs/research/2026-06-16-cmux-events-stream.md (C2 finding).
     */
    cmuxAgentHibernation?: boolean;
  };
  metrics: {
    enabled: boolean;
    path: string;
  };
}

const CONFIG_DIR = path.join(os.homedir(), ".config", "cockpit");
export const DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export function getDefaultConfig(): CockpitConfig {
  return {
    commandName: "\u{1F3DB}\u{FE0F} command",
    hubVault: path.join(os.homedir(), "cockpit-hub"),
    projects: {},
    agents: {
      claude: { cli: "claude", driver: "claude" },
    },
    defaults: {
      maxCrew: 5,
      worktreeDir: ".worktrees",
      teammateMode: "in-process",
      permissions: {
        command: "auto",
        captain: "auto",
        crew: "auto",
      },
      models: {
        command: "opus",
        captain: "opus",
        crew: "opus",
        exploration: "haiku",
        review: "opus",
      },
      roles: {
        command: { agent: "claude", model: "opus" },
        captain: { agent: "claude", model: "opus" },
        crew: { agent: "claude", model: "opus" },
        exploration: { agent: "claude", model: "haiku" },
        side: { agent: "claude", model: "opus" },
      },
      taskTimeoutMs: 8 * 60 * 60 * 1000,
      cmuxEventsBridge: true,
      // Audit C2: OFF by design — cmux hibernation is global-only and would
      // hibernate the captain/relay. See the field doc above.
      cmuxAgentHibernation: false,
      // #332: daemon-direct cmux — OFF for safe rollout; set true to retire the relay.
      daemonDirectCmux: false,
      crewRouting: {
        rules: [
          { tier: "extreme", match: "redesign|architect|rewrite|from scratch|deep reasoning", agent: "claude", model: "opus" },
          { tier: "hard", match: "refactor|migrate|implement|feature|daemon|control-plane", agent: "claude", model: "sonnet" },
          { tier: "mobile", match: "mobile|ios|swift|android|kotlin|react native", agent: "codex" },
          { tier: "daily", match: "typo|rename|bump|docs|comment|lint|format", agent: "opencode" },
        ],
      },
    },
    metrics: {
      enabled: true,
      path: path.join(CONFIG_DIR, "metrics.json"),
    },
  };
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH): CockpitConfig {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as CockpitConfig;

    // Backward compat: migrate models → roles if roles not set
    if (config.defaults.models && !config.defaults.roles) {
      const m = config.defaults.models;
      config.defaults.roles = {
        command: { agent: "claude", model: m.command },
        captain: { agent: "claude", model: m.captain },
        crew: { agent: "claude", model: m.crew },
        exploration: { agent: "claude", model: m.exploration },
      };
    }

    // Ensure agents has at least claude
    if (!config.agents) {
      config.agents = { claude: { cli: "claude", driver: "claude" } };
    }

    // #286: backfill crewRouting for configs written before routing existed
    if (!config.defaults.crewRouting) {
      config.defaults.crewRouting = getDefaultConfig().defaults.crewRouting;
      saveConfig(config, configPath);
      console.error(
        chalk.cyan(
          "⬆ cockpit upgrade: added default crew routing rules to your config (leveled routing now active). " +
          "Edit defaults.crewRouting in ~/.config/cockpit/config.json or use the cockpit:add-pick-crew-rule skill.",
        ),
      );
    }

    return config;
  } catch {
    return getDefaultConfig();
  }
}

export function saveConfig(
  config: CockpitConfig,
  configPath = DEFAULT_CONFIG_PATH,
): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

export function resolveHome(p: string): string {
  return p.startsWith("~") ? p.replace("~", os.homedir()) : p;
}
