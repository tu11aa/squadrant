// Cross-project intra-group dispatch orchestration (#246/#367).
// Pure-ish library function: validation + boot-if-down + record-task.
// CLI-edge concerns (shelling out to `squadrant launch`) are injected via bootCaptain.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveHome, type SquadrantConfig } from "@squadrant/shared";
import { sendRequest } from "./protocol.js";
import type { TaskRecord, Provider, Mode } from "@squadrant/shared";

const DEFAULT_SOCK_PATH = join(homedir(), ".config", "squadrant", "squadrant.sock");

// #288: cold captain boot takes 45-90s; 120s gives the full chain comfortable headroom.
export const GROUP_DISPATCH_WARMUP_TIMEOUT_MS = 120_000;
export const GROUP_DISPATCH_WARMUP_POLL_MS = 1_000;

/** Resolve the current project name by matching cwd against config paths. */
export function resolveCurrentProject(config: SquadrantConfig): string | null {
  const cwd = process.cwd();
  for (const [name, proj] of Object.entries(config.projects)) {
    const resolvedPath = resolveHome(proj.path);
    if (cwd.startsWith(resolvedPath)) return name;
  }
  return null;
}

/** Check via the daemon health endpoint whether a project's captain is up. */
export async function isCaptainAlive(
  project: string,
  sockPath: string = DEFAULT_SOCK_PATH,
): Promise<boolean> {
  try {
    const health = (await sendRequest(sockPath, { kind: "health", project }, 5000)) as Array<{
      kind: string; project: string; state: string;
    }>;
    const captain = health?.find((h) => h.kind === "captain" && h.project === project);
    return captain != null && captain.state !== "gone" && captain.state !== "unknown";
  } catch {
    return false;
  }
}

/** Poll the daemon health endpoint until the target project's captain is up,
 *  or the hard timeout expires. Returns true if warmup succeeded. */
export async function waitForWarmup(
  project: string,
  sockPath: string = DEFAULT_SOCK_PATH,
  timeoutMs = GROUP_DISPATCH_WARMUP_TIMEOUT_MS,
  pollMs = GROUP_DISPATCH_WARMUP_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCaptainAlive(project, sockPath)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

export interface GroupDispatchOpts {
  fromProject: string;
  toProject: string;
  task: string;
  provider?: Provider;
  mode?: Mode;
  sockPath?: string;
  warmupTimeoutMs?: number;
  warmupPollMs?: number;
  /** CLI-edge: shells out to launch the target captain. Injected by the command handler. */
  bootCaptain?: (project: string) => Promise<void>;
}

/**
 * Dispatch a task to a sibling project in the same group.
 * Validates same-group membership and acceptDelegations, boots the target captain
 * if needed (via injected bootCaptain), then records the task via the daemon.
 * Dispatch-and-yield: returns immediately after recording.
 */
export async function dispatchToSibling(opts: GroupDispatchOpts): Promise<TaskRecord> {
  const config = loadConfig();
  const fromCfg = config.projects[opts.fromProject];
  const toCfg = config.projects[opts.toProject];

  if (!toCfg) {
    throw new Error(`target project '${opts.toProject}' not found in config`);
  }

  // #246: same-group gate — hard boundary
  if (!fromCfg.group || !toCfg.group || fromCfg.group !== toCfg.group) {
    throw new Error(
      `cannot dispatch: '${opts.toProject}' (group: ${toCfg.group ?? "none"}) ` +
      `is not in the same group as '${opts.fromProject}' (group: ${fromCfg.group ?? "none"})`,
    );
  }

  // #246: acceptDelegations check
  if (toCfg.acceptDelegations === false) {
    throw new Error(
      `cannot dispatch to '${opts.toProject}': project has acceptDelegations set to false`,
    );
  }

  const sockPath = opts.sockPath ?? DEFAULT_SOCK_PATH;

  // Ensure target captain is up; boot via injected callback if not
  const alive = await isCaptainAlive(opts.toProject, sockPath);
  if (!alive) {
    if (opts.bootCaptain) {
      await opts.bootCaptain(opts.toProject);
    }
    const warmed = await waitForWarmup(
      opts.toProject,
      sockPath,
      opts.warmupTimeoutMs,
      opts.warmupPollMs,
    );
    if (!warmed) {
      throw new Error(
        `dispatch to '${opts.toProject}' timed out waiting for captain warmup ` +
        `(>${(opts.warmupTimeoutMs ?? GROUP_DISPATCH_WARMUP_TIMEOUT_MS) / 1000}s)`,
      );
    }
  }

  // Record the task via the daemon (dispatch-and-yield)
  const now = Date.now();
  const attemptId = randomUUID();
  const record: TaskRecord = {
    id: randomUUID(),
    project: opts.toProject,
    originProject: opts.fromProject,
    provider: opts.provider ?? "claude",
    mode: opts.mode ?? "headless",
    state: "submitted",
    task: opts.task,
    createdAt: now,
    lastHeartbeat: now,
    lastEvent: "dispatch",
    heartbeatBudgetMs: 300000,
    attempts: [{ attemptId, startedAt: now, lastHeartbeatAt: now }],
  };

  const result = (await sendRequest(sockPath, { kind: "dispatch", record })) as TaskRecord;
  return result;
}
