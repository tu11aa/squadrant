import fs from "node:fs";
import path from "node:path";
import type { CockpitConfig } from "../config.js";
import { resolveHome } from "../config.js";

export type DashboardState = "idle" | "busy" | "blocked" | "errored" | "offline" | "unknown";

const KNOWN_STATES: ReadonlyArray<DashboardState> = [
  "idle", "busy", "blocked", "errored", "offline", "unknown",
];

export interface ProjectStatus {
  project: string;
  state: DashboardState;
  lastChecked: string;       // ISO-8601 string, "" if unknown
  captainWorkspace: string;  // "" if unknown
  excerpt: string;           // multi-line, possibly ""
}

export interface ReadStatusDeps {
  config: CockpitConfig;
  readFile?: (path: string) => string;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseStatusFile(text: string): ProjectStatus | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;

  const fm: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "---") { i++; break; }
    const m = lines[i].match(/^([a-z_]+):\s*(.*)$/i);
    if (m) fm[m[1]] = unquote(m[2]);
  }
  if (!fm.auto_state) return null;

  // Find the first fenced block after "## Last activity excerpt"
  let excerpt = "";
  const headerIdx = lines.findIndex((l, idx) => idx >= i && /##\s+Last activity excerpt/i.test(l));
  if (headerIdx >= 0) {
    const fenceStart = lines.findIndex((l, idx) => idx > headerIdx && l.trim() === "```");
    if (fenceStart >= 0) {
      const fenceEnd = lines.findIndex((l, idx) => idx > fenceStart && l.trim() === "```");
      if (fenceEnd > fenceStart) excerpt = lines.slice(fenceStart + 1, fenceEnd).join("\n");
    }
  }

  const rawState = (fm.auto_state || "unknown") as DashboardState;
  const state = KNOWN_STATES.includes(rawState) ? rawState : "unknown";

  return {
    project: fm.project ?? "",
    state,
    lastChecked: fm.auto_last_checked ?? "",
    captainWorkspace: fm.captain_workspace ?? "",
    excerpt,
  };
}

export function readAllStatuses(deps: ReadStatusDeps): ProjectStatus[] {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf-8"));
  const rows: ProjectStatus[] = [];
  for (const [name, project] of Object.entries(deps.config.projects)) {
    const statusPath = path.join(resolveHome(project.spokeVault), "status.md");
    let text = "";
    try { text = readFile(statusPath); } catch { /* missing — leave text empty */ }
    const parsed = text ? parseStatusFile(text) : null;
    rows.push(parsed
      ? { ...parsed, project: name }
      : { project: name, state: "unknown", lastChecked: "", captainWorkspace: project.captainName, excerpt: "" });
  }
  return rows;
}
