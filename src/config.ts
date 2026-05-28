// src/config.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ProjectConfig {
  path: string;
  captainName: string;
  spokeVault: string;
  host: string;
  group?: string;
  groupRole?: string;
  runtime?: string;
  workspace?: string;
}

export interface PermissionConfig {
  command: string;   // permission mode for the command session
  captain: string;   // permission mode for captain sessions
}

export type ModelAlias = "opus" | "sonnet" | "haiku";

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

export type RoleConfig = Partial<Record<"command" | "captain" | "crew" | "exploration", RoleAssignment>>;

export interface CockpitConfig {
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
  defaults: {
    maxCrew: number;
    worktreeDir: string;
    teammateMode: string;
    permissions: PermissionConfig;
    models?: ModelRoutingConfig;
    roles?: RoleConfig;
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
      },
      models: {
        command: "opus",
        captain: "opus",
        crew: "sonnet",
        exploration: "haiku",
        review: "opus",
      },
      roles: {
        command: { agent: "claude", model: "opus" },
        captain: { agent: "claude", model: "opus" },
        crew: { agent: "claude", model: "sonnet" },
        exploration: { agent: "claude", model: "haiku" },
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
