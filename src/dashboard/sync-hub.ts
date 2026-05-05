import fs from "node:fs";
import path from "node:path";
import type { CockpitConfig } from "../config.js";
import { resolveHome } from "../config.js";
import type { ProjectStatus } from "./read-status.js";

export interface SyncHubResult {
  project: string;
  hubPath: string;
}

export interface SyncHubDeps {
  config: CockpitConfig;
  statuses: ProjectStatus[];
  writeFile?: (path: string, content: string) => void;
  mkdir?: (dirPath: string) => void;
}

export function buildMirrorMarkdown(s: ProjectStatus): string {
  const fenced = "```";
  return [
    "---",
    `project: ${s.project}`,
    `auto_state: ${s.state}`,
    `auto_last_checked: "${s.lastChecked}"`,
    `captain_workspace: ${s.captainWorkspace}`,
    "---",
    "",
    `# ${s.project}`,
    "",
    "> Mirror of `{spokeVault}/status.md`. Updated by `cockpit dashboard sync-hub` (#44).",
    "",
    "## Last activity excerpt",
    "",
    fenced,
    s.excerpt,
    fenced,
    "",
  ].join("\n");
}

export function syncHub(deps: SyncHubDeps): SyncHubResult[] {
  if (!deps.config.hubVault) return [];

  const writeFile = deps.writeFile ?? ((p, c) => fs.writeFileSync(p, c));
  const mkdir = deps.mkdir ?? ((p) => fs.mkdirSync(p, { recursive: true }));

  const projectsDir = path.join(resolveHome(deps.config.hubVault), "projects");
  mkdir(projectsDir);

  const out: SyncHubResult[] = [];
  for (const s of deps.statuses) {
    if (s.state === "unknown") continue;
    const hubPath = path.join(projectsDir, `${s.project}.md`);
    try {
      writeFile(hubPath, buildMirrorMarkdown(s));
      out.push({ project: s.project, hubPath });
    } catch { /* best-effort */ }
  }
  return out;
}
