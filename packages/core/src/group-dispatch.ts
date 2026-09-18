// Cross-project dispatch orchestration (#246/#367; hard group-gate relaxed for
// cross-project ping & dispatch). Pure-ish library function: validation +
// boot-if-down (same-group only) + record-task.
// CLI-edge concerns (shelling out to `squadrant launch`) are injected via bootCaptain.

import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveHome, DAEMON_SOCK_PATH, CONFIG_DIR, type SquadrantConfig } from "@squadrant/shared";
import { sendRequest } from "./protocol.js";
import { readCaptainAddress } from "./captain-record.js";
import { captainSocketPath } from "./captain-channel.js";
import type { TaskRecord, Provider, Mode } from "@squadrant/shared";

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

/** Probe a project's captain control channel directly (#799). Injectable so
 *  callers/tests can substitute a fake; defaults to the real local probe. */
export type CaptainChannelProbe = (project: string) => Promise<boolean>;

/** #799: the surface-derived captain row lags — an opencode captain whose
 *  workspace was closed/never seen reads `stopped` even though its HTTP
 *  control channel is up and delivering. Probe the recorded address directly:
 *  a live opencode port, or a claude peer socket that accepts a connection. */
export async function probeCaptainChannel(
  project: string,
  opts: {
    stateRoot?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** Injected for tests; defaults to a real UDS connect. */
    socketAccepts?: (socketPath: string) => Promise<boolean>;
  } = {},
): Promise<boolean> {
  const stateRoot = opts.stateRoot ?? join(CONFIG_DIR, "state");
  const addr = readCaptainAddress(stateRoot, project);
  if (!addr) return false;
  if (addr.agent === "opencode") {
    if (addr.port == null) return false;
    return httpReachable(addr.port, opts.fetchImpl ?? fetch, opts.timeoutMs ?? 5000);
  }
  // claude (and any other socket-addressable agent): the peer socket answers.
  try {
    return await (opts.socketAccepts ?? socketAccepts)(captainSocketPath(project));
  } catch {
    return false;
  }
}

/** GET either opencode session route; an OK response means the port is live.
 *  Mirrors opencode-session.ts's legacy-then-/api fallback (never throws). */
async function httpReachable(
  port: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  for (const path of ["/session", "/api/session"]) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}${path}`, { signal: ac.signal });
      if (res.ok) return true;
    } catch {
      // transport failure — try the next route
    } finally {
      clearTimeout(t);
    }
  }
  return false;
}

/** True when a UDS at `socketPath` accepts a connection. A stale socket file
 *  with no listener errors (ECONNREFUSED) → false. */
function socketAccepts(socketPath: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const sock = createConnection(socketPath);
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Check via the daemon health endpoint whether a project's captain is up. */
export async function isCaptainAlive(
  project: string,
  sockPath: string = DAEMON_SOCK_PATH,
  channelAlive: CaptainChannelProbe = probeCaptainChannel,
): Promise<boolean> {
  try {
    const health = (await sendRequest(sockPath, { kind: "health", project }, 5000)) as Array<{
      kind: string; project: string; state: string;
    }>;
    const captain = health?.find((h) => h.kind === "captain" && h.project === project);
    // Captain rows only ever report "alive" | "stopped" | "unknown" (see
    // liveness.ts projectHealth) — "stopped" means the workspace was closed
    // (down), so it must NOT count as alive on its own.
    if (captain?.state === "alive") return true;
  } catch {
    // Daemon unreachable — fall through to the channel probe rather than
    // declaring the captain down.
  }
  // #799: a reachable control channel is ground truth that the captain is up,
  // even when the surface-derived row is stale. A genuinely down captain has no
  // live channel, so it still reports not-alive here.
  try {
    return await channelAlive(project);
  } catch {
    return false;
  }
}

/** Poll the daemon health endpoint until the target project's captain is up,
 *  or the hard timeout expires. Returns true if warmup succeeded. */
export async function waitForWarmup(
  project: string,
  sockPath: string = DAEMON_SOCK_PATH,
  timeoutMs = GROUP_DISPATCH_WARMUP_TIMEOUT_MS,
  pollMs = GROUP_DISPATCH_WARMUP_POLL_MS,
  channelAlive?: CaptainChannelProbe,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCaptainAlive(project, sockPath, channelAlive)) return true;
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
  /** #799: overrides the captain control-channel probe (defaults to the local
   *  probe). Tests inject a fake; production uses the real address probe. */
  channelAlive?: CaptainChannelProbe;
}

/**
 * Dispatch a task to any registered project. Validates acceptDelegations,
 * then records the task via the daemon. Same-group targets additionally get
 * boot-if-down (via injected bootCaptain); cross-group targets must already
 * be running — see the same-group check inline below.
 * Dispatch-and-yield: returns immediately after recording.
 */
export async function dispatchToSibling(opts: GroupDispatchOpts): Promise<TaskRecord> {
  const config = loadConfig();
  const fromCfg = config.projects[opts.fromProject];
  const toCfg = config.projects[opts.toProject];

  if (!toCfg) {
    throw new Error(`target project '${opts.toProject}' not found in config`);
  }

  // #246/#367: dispatch reaches any registered project. Same group only grants
  // the richer guarantees below (auto-accept default, boot-if-down); it is no
  // longer a hard gate on whether dispatch is allowed at all.
  const sameGroup = !!fromCfg?.group && !!toCfg.group && fromCfg.group === toCfg.group;

  // #246: acceptDelegations check (applies regardless of group)
  if (toCfg.acceptDelegations === false) {
    throw new Error(
      `cannot dispatch to '${opts.toProject}': project has acceptDelegations set to false`,
    );
  }

  const sockPath = opts.sockPath ?? DAEMON_SOCK_PATH;

  // Ensure target captain is up. Same-group boots via the injected callback;
  // cross-group does not auto-boot — fail fast with a clear next step instead.
  // #799: "up" is channel-aware — a reachable control channel counts even when
  // the surface-derived health row is stale.
  const alive = await isCaptainAlive(opts.toProject, sockPath, opts.channelAlive);
  if (!alive) {
    if (!sameGroup) {
      throw new Error(
        `cannot dispatch to '${opts.toProject}': captain is not running and cross-group ` +
        `dispatch does not auto-boot it. Use 'squadrant ping ${opts.toProject} "<msg>"' or ` +
        `start it manually with 'squadrant launch ${opts.toProject}', then retry.`,
      );
    }
    if (opts.bootCaptain) {
      await opts.bootCaptain(opts.toProject);
    }
    const warmed = await waitForWarmup(
      opts.toProject,
      sockPath,
      opts.warmupTimeoutMs,
      opts.warmupPollMs,
      opts.channelAlive,
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
