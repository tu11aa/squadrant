// #1029: who is running `squadrant ping` / `runtime send` — the sender label shown in the delivery header.
// Being under a registered project's directory does NOT make a session that project's captain (crews, side
// sessions and the operator's own shell all live there), so the label comes from the session's own markers:
//   crew env   → crew:<project>/<name>   (name from the task record, else the short task id)
//   thread tab → thread:<id>
//   side tab   → side                    (its name is not in the env)
//   captain    → captain:<project>       (SQUADRANT_ROLE=captain, project from cwd)
//   otherwise  → cli
import { loadConfig } from "@squadrant/shared";
import { resolveCurrentProject, createStore } from "@squadrant/core";
import { stateRoot } from "@squadrant/shared";

export interface SenderLabelDeps {
  env: NodeJS.ProcessEnv;
  /** The registered project containing the cwd, if any. */
  currentProject: () => string | null;
  taskName?: (project: string, id: string) => string | undefined;
}

export function senderLabel(deps: SenderLabelDeps): string {
  const { env } = deps;
  const crewId = env.SQUADRANT_CREW_TASK_ID;
  if (crewId) {
    const project = env.SQUADRANT_CREW_PROJECT || deps.currentProject();
    if (project) return `crew:${project}/${deps.taskName?.(project, crewId) ?? crewId.slice(0, 8)}`;
    return "cli";
  }
  if (env.SQUADRANT_ROLE === "thread" && env.SQUADRANT_THREAD_ID) return `thread:${env.SQUADRANT_THREAD_ID}`;
  if (env.SQUADRANT_SIDE_SESSION === "1") return "side";
  if (env.SQUADRANT_ROLE === "captain") {
    const project = deps.currentProject();
    if (project) return `captain:${project}`;
  }
  return "cli";
}

/** The real-environment label for the current process. */
export function currentSenderLabel(config: ReturnType<typeof loadConfig>): string {
  return senderLabel({
    env: process.env,
    currentProject: () => resolveCurrentProject(config),
    taskName: (project, id) => {
      try { return createStore(stateRoot()).get(project, id)?.name; } catch { return undefined; }
    },
  });
}
