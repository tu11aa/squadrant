import fs from "node:fs";
import path from "node:path";
import type { CockpitConfig, ReactionsConfig } from "../config.js";
import { resolveHome } from "../config.js";
import type { RuntimeDriver } from "../runtimes/types.js";
import { classifyScreen, type ScreenState } from "./status-classifier.js";

export interface AutoStatusResult {
  project: string;
  state: ScreenState;
  vaultPath: string;
}

export interface AutoStatusDeps {
  config: CockpitConfig;
  reactions: ReactionsConfig;
  runtime: (project: string) => RuntimeDriver;
  now?: () => string;
  writeFile?: (filePath: string, content: string) => void;
  mkdir?: (dirPath: string) => void;
}

const DEFAULT_AUTO_STATUS = { enabled: true, lines: 50, excerpt_lines: 15 };

function buildStatusMarkdown(input: {
  project: string;
  captainWorkspace: string;
  state: ScreenState;
  lastChecked: string;
  excerpt: string;
}): string {
  const fenced = "```";
  return [
    "---",
    `project: ${input.project}`,
    `auto_state: ${input.state}`,
    `auto_last_checked: "${input.lastChecked}"`,
    `captain_workspace: ${input.captainWorkspace}`,
    "---",
    "",
    "# Status (auto-derived)",
    "",
    "> Written by `cockpit reactor poll-status`. Manual writes (`write-status.sh`) are opt-in and may be clobbered on the next poll.",
    "",
    "## Last activity excerpt",
    "",
    fenced,
    input.excerpt,
    fenced,
    "",
  ].join("\n");
}

export async function runAutoStatus(deps: AutoStatusDeps): Promise<AutoStatusResult[]> {
  const cfg = deps.reactions.auto_status ?? DEFAULT_AUTO_STATUS;
  if (!cfg.enabled) return [];

  const lines = cfg.lines ?? DEFAULT_AUTO_STATUS.lines;
  const excerptLines = cfg.excerpt_lines ?? DEFAULT_AUTO_STATUS.excerpt_lines;
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const writeFile = deps.writeFile ?? ((p, c) => fs.writeFileSync(p, c));
  const mkdir = deps.mkdir ?? ((p) => fs.mkdirSync(p, { recursive: true }));

  const results: AutoStatusResult[] = [];

  for (const [name, project] of Object.entries(deps.config.projects)) {
    const captain = project.captainName;
    const vaultDir = resolveHome(project.spokeVault);
    const statusPath = path.join(vaultDir, "status.md");

    let screen = "";
    try {
      const driver = deps.runtime(name);
      screen = await driver.readScreen(captain);
    } catch {
      screen = "";
    }

    const { state, excerpt } = classifyScreen(screen, { lines, excerptLines });

    try {
      mkdir(vaultDir);
      writeFile(statusPath, buildStatusMarkdown({
        project: name,
        captainWorkspace: captain,
        state,
        lastChecked: now,
        excerpt,
      }));
    } catch {
      // best-effort: skip projects whose vault is unreachable
    }

    results.push({ project: name, state, vaultPath: statusPath });
  }

  return results;
}
