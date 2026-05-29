import type { CockpitConfig } from "../config.js";
import type { TaskRecord } from "../control/types.js";
import { cockpitdCall } from "../commands/crew-control.js";

export type DashboardState = "idle" | "busy" | "blocked" | "errored" | "offline" | "unknown";

export interface ProjectStatus {
  project: string;
  state: DashboardState;
  lastChecked: string;
  captainWorkspace: string;
  excerpt: string;
}

export interface ReadStatusDeps {
  config: CockpitConfig;
  listTasks?: (project: string) => Promise<TaskRecord[]>;
}

function deriveState(tasks: TaskRecord[]): DashboardState {
  if (tasks.some(t => t.state === "blocked" || t.state === "awaiting-input")) return "blocked";
  if (tasks.some(t => t.state === "failed" || t.state === "stalled")) return "errored";
  if (tasks.some(t => t.state === "working")) return "busy";
  return "idle";
}

function buildExcerpt(tasks: TaskRecord[]): string {
  const working = tasks.filter(t => t.state === "working").length;
  const blocked = tasks.filter(t => t.state === "blocked" || t.state === "awaiting-input").length;
  const parts: string[] = [];
  if (working > 0) parts.push(`${working} working`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  const summary = parts.length > 0 ? parts.join(", ") : "idle";

  const active = tasks.filter(t =>
    ["working", "blocked", "awaiting-input", "submitted"].includes(t.state)
  );
  const titles = active.slice(0, 3).map(t => {
    const firstLine = t.task ? t.task.split("\n")[0] : "";
    return t.name ?? (firstLine || t.id.slice(0, 8));
  }).join("; ");

  return titles ? `${summary} — ${titles}` : summary;
}

export async function readAllStatuses(deps: ReadStatusDeps): Promise<ProjectStatus[]> {
  const listTasks = deps.listTasks ?? (async (project: string) => {
    const result = await cockpitdCall({ kind: "list", project });
    return result as TaskRecord[];
  });

  const rows: ProjectStatus[] = [];
  for (const [name, project] of Object.entries(deps.config.projects)) {
    try {
      const tasks = await listTasks(name);
      rows.push({
        project: name,
        state: deriveState(tasks),
        lastChecked: new Date().toISOString(),
        captainWorkspace: project.captainName,
        excerpt: buildExcerpt(tasks),
      });
    } catch {
      rows.push({
        project: name,
        state: "offline",
        lastChecked: new Date().toISOString(),
        captainWorkspace: project.captainName,
        excerpt: "",
      });
    }
  }
  return rows;
}
