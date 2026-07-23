import type { SquadrantConfig } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";
import type { ComponentHealth, HealthState } from "@squadrant/core";

export type SquadrantdCall = (req: unknown) => Promise<unknown>;

export type DashboardState = "idle" | "busy" | "blocked" | "errored" | "offline" | "unknown";

export interface ProjectStatus {
  project: string;
  state: DashboardState;
  lastChecked: string;
  captainWorkspace: string;
  excerpt: string;
}

export interface ReadStatusDeps {
  config: SquadrantConfig;
  call?: SquadrantdCall;
  listTasks?: (project: string) => Promise<TaskRecord[]>;
}

function deriveState(tasks: TaskRecord[]): DashboardState {
  // #599: a crew awaiting review needs the captain's attention exactly like
  // blocked/awaiting-input — group it into the same dashboard bucket.
  if (tasks.some(t => t.state === "blocked" || t.state === "awaiting-input" || t.state === "review")) return "blocked";
  if (tasks.some(t => t.state === "failed" || t.state === "stalled")) return "errored";
  if (tasks.some(t => t.state === "working")) return "busy";
  return "idle";
}

/** Captain liveness dominates task activity (§6): a gone/stopped captain means
 *  the project is offline regardless of what its (about-to-be-reaped) tasks say. */
export function deriveRowState(tasks: TaskRecord[], captainState: HealthState): DashboardState {
  if (captainState === "gone" || captainState === "stopped" || captainState === "unknown") return "offline";
  return deriveState(tasks);
}

function buildExcerpt(tasks: TaskRecord[]): string {
  const working = tasks.filter(t => t.state === "working").length;
  const blocked = tasks.filter(t => t.state === "blocked" || t.state === "awaiting-input" || t.state === "review").length;
  const parts: string[] = [];
  if (working > 0) parts.push(`${working} working`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  const summary = parts.length > 0 ? parts.join(", ") : "idle";

  const active = tasks.filter(t =>
    ["working", "blocked", "awaiting-input", "review", "submitted"].includes(t.state)
  );
  const titles = active.slice(0, 3).map(t => {
    const firstLine = t.task ? t.task.split("\n")[0] : "";
    return t.name ?? (firstLine || t.id.slice(0, 8));
  }).join("; ");

  return titles ? `${summary} — ${titles}` : summary;
}

export async function readAllStatuses(deps: ReadStatusDeps): Promise<ProjectStatus[]> {
  const listTasks = deps.listTasks ?? (async (project: string) => {
    if (!deps.call) throw new Error("ReadStatusDeps: call is required when listTasks is not provided");
    const result = await deps.call({ kind: "list", project });
    return result as TaskRecord[];
  });

  // Fetch health ONCE (not per project) and index captain state by project —
  // captain liveness dominates task-derived state (§6).
  const captainStateByProject = new Map<string, HealthState>();
  if (deps.call) {
    try {
      const health = (await deps.call({ kind: "health" })) as ComponentHealth[];
      for (const h of health ?? []) {
        if (h.kind === "captain") captainStateByProject.set(h.project, h.state);
      }
    } catch { /* health unavailable — fall back to task-derived state only */ }
  }

  const rows: ProjectStatus[] = [];
  for (const [name, project] of Object.entries(deps.config.projects)) {
    try {
      const tasks = await listTasks(name);
      const captainState = captainStateByProject.get(name) ?? "unknown";
      rows.push({
        project: name,
        state: deriveRowState(tasks, captainState),
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
