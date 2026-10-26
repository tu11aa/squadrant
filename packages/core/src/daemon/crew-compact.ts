// #1051: `squadrant crew compact` — queue a /compact for a crew and type it into the crew's pane
// only once the crew is idle. Mirrors captain-compact.ts: no API compacts a Claude/opencode
// session from outside and `crew send "/compact"` arrives as a peer message that never runs the
// slash command, so the daemon types it through the pane behind the usual send guard.
// Crew-bound delivery (`crew send`, a CLI-side path) asks `holdsCrew` and waits while a compact is
// queued or running, so a message sent meanwhile lands after the compact, never inside its summary.
import { loadConfig } from "@squadrant/shared";
import { TERMINAL_STATES } from "@squadrant/shared";
import type { PaneRef, TaskRecord } from "@squadrant/shared";
import type { DaemonSurfaceDriver } from "../interfaces.js";
import { DeferDelivery } from "../delivery/defer-delivery.js";
import { titleFor } from "../crew-protocol.js";
import { CC_WORKING_RE, COMPACT_HOLD_MS, COMPACT_TIMEOUT_MS } from "./captain-compact.js";

const IDLE_POLLS = 2;
/** Agents whose pane takes a typed `/compact`. codex crews render an app-server thread (typed text
 *  becomes a turn, not a slash command); gemini crews are one-shot headless (#81). */
const COMPACTABLE = new Set(["claude", "opencode"]);
/** Task states in which the crew is mid-turn or waiting on something — never type over them. */
const BUSY_STATES = new Set(["submitted", "working", "blocked", "stalled"]);

interface Pending { taskId: string; agent: string; keep: string | undefined; deadline: number; idlePolls: number; lastReason?: string; lastNoteAt?: number }

export interface CrewCompactDeps {
  cmux: DaemonSurfaceDriver;
  log: (line: string) => void;
  /** All task records of a project (the daemon store). */
  tasks: (project: string) => TaskRecord[];
  now?: () => number;
  timeoutMs?: number;
  holdMs?: number;
  /** Override for tests; defaults to the loaded config's captain title (the crew's workspace). */
  captainTitle?: (project: string) => string;
  /** Fallback crew surfaces when workspace discovery finds nothing (tests). Keyed `project:crew`. */
  injectedSurfaces?: Record<string, PaneRef>;
}

export function createCrewCompact(deps: CrewCompactDeps) {
  const { cmux, log } = deps;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? COMPACT_TIMEOUT_MS;
  const holdMs = deps.holdMs ?? COMPACT_HOLD_MS;
  /** Keyed by task id. */
  const pending = new Map<string, Pending & { project: string; name: string }>();
  const holds = new Map<string, { until: number; project: string; name: string }>();

  const titleOf = (project: string): string => {
    if (deps.captainTitle) return deps.captainTitle(project);
    const cfg = loadConfig();
    return project === cfg.commandName ? cfg.commandName : (cfg.projects?.[project]?.captainName ?? `${project}-captain`);
  };

  /** The crew's live record: the most recently created task with this name. */
  function taskFor(project: string, name: string): TaskRecord | undefined {
    const matches = deps.tasks(project).filter((t) => t.name === name);
    return matches.length ? matches.reduce((a, b) => ((b.createdAt ?? 0) > (a.createdAt ?? 0) ? b : a)) : undefined;
  }

  async function resolveSurface(project: string, name: string): Promise<PaneRef | null> {
    const wsId = await cmux.findWorkspaceId(titleOf(project));
    if (wsId) {
      const want = titleFor(project, name);
      const hit = (await cmux.listSurfaces(wsId)).find((s) => s.title === want);
      if (hit) return hit;
    }
    return deps.injectedSurfaces?.[`${project}:${name}`] ?? null;
  }

  /** Validate and queue; returns once queued (the daemon owns the wait and the typing). */
  async function request(project: string, name: string, keep?: string): Promise<{ queued: true; agent: string }> {
    const task = taskFor(project, name);
    if (!task) throw new Error(`Crew '${name}' not found for ${project}. Run 'squadrant crew list ${project}'.`);
    if (task.operatorHold) {
      throw new Error(`Crew '${name}' is under operator takeover — the operator is working in that tab. Ask them to run 'squadrant crew handback ${project} ${name}' first.`);
    }
    if (task.state === "cancelled") throw new Error(`Crew '${name}' has ended (its session is gone) — there is nothing to compact.`);
    if (!COMPACTABLE.has(task.provider)) {
      throw new Error(`Crew '${name}' runs ${task.provider}, which squadrant cannot compact from outside — spawn a fresh crew with a brief instead.`);
    }
    if (!(await resolveSurface(project, name))) throw new Error(`Crew '${name}' has no live pane to compact. Run 'squadrant crew list ${project}'.`);
    pending.set(task.id, { project, name, taskId: task.id, agent: task.provider, keep: keep?.trim() || undefined, deadline: now() + timeoutMs, idlePolls: 0 });
    log(`crew-compact ${project}:${name}: queued, waiting for idle crew`);
    return { queued: true, agent: task.provider };
  }

  /** True while a compact is queued or running for this crew — `crew send` waits. */
  function holdsCrew(project: string, name: string): boolean {
    const task = taskFor(project, name);
    if (!task) return false;
    if (pending.has(task.id)) return true;
    const h = holds.get(task.id);
    if (!h) return false;
    if (now() <= h.until) return true;
    holds.delete(task.id);
    log(`crew-compact ${project}:${name}: hold lapsed (no SessionStart(compact) within ${Math.round(holdMs / 1000)}s) — delivery resumed`);
    return false;
  }

  /** SessionStart(source=compact) arrived for this crew's session — the window is over. */
  function compactDone(taskId: string): void {
    const h = holds.get(taskId);
    if (h && holds.delete(taskId)) log(`crew-compact ${h.project}:${h.name}: compact finished — delivery resumed`);
  }

  /** Say why a queued compact is still waiting, at most once a minute, so a stuck one is diagnosable. */
  function noteWaiting(p: Pending & { project: string; name: string }): void {
    if (p.lastNoteAt !== undefined && now() - p.lastNoteAt < 60_000) return;
    p.lastNoteAt = now();
    log(`crew-compact ${p.project}:${p.name}: still waiting (${p.lastReason})`);
  }

  async function tryOne(taskId: string, p: Pending & { project: string; name: string }): Promise<void> {
    const label = `${p.project}:${p.name}`;
    if (now() > p.deadline) {
      pending.delete(taskId);
      log(`crew-compact ${label}: timed out after ${Math.round(timeoutMs / 1000)}s waiting for an idle crew (last: ${p.lastReason ?? "busy"}) — not compacted`);
      return;
    }
    const task = deps.tasks(p.project).find((t) => t.id === taskId);
    if (!task || task.state === "cancelled") {
      pending.delete(taskId);
      log(`crew-compact ${label}: crew ended — compact dropped`);
      return;
    }
    if (task.operatorHold) {
      pending.delete(taskId);
      log(`crew-compact ${label}: operator took over — compact dropped`);
      return;
    }
    // A terminal task can carry a stale pendingTool (the signal tool that ended it never got its
    // PostToolUse), so an open tool only counts while the task is live; the pane decides after that.
    const live = !TERMINAL_STATES.has(task.state);
    if (BUSY_STATES.has(task.state) || (live && (task.pendingTool || task.pendingMonitor))) {
      p.idlePolls = 0;
      p.lastReason = BUSY_STATES.has(task.state) ? `state-${task.state}` : "tool-open";
      noteWaiting(p);
      return;
    }
    const surface = await resolveSurface(p.project, p.name);
    if (!surface) { p.lastReason = "no-surface"; noteWaiting(p); return; }
    const screen = await cmux.readPaneScreen(surface);
    // The Claude spinner regex is only meaningful on a Claude pane; other agents rely on task state.
    if (screen == null || (p.agent === "claude" && CC_WORKING_RE.test(screen))) {
      p.idlePolls = 0;
      p.lastReason = screen == null ? "unreadable" : "turn-in-flight";
      noteWaiting(p);
      return;
    }
    if (++p.idlePolls < IDLE_POLLS) return;
    try {
      await cmux.send(surface, p.keep ? `/compact ${p.keep}` : "/compact", { agent: p.agent });
    } catch (e) {
      if (!(e instanceof DeferDelivery)) throw e;
      p.idlePolls = 0;
      p.lastReason = e.reason;
      return;
    }
    // The hold persists until SessionStart(compact) (claude) or until it lapses (opencode has no such hook).
    holds.set(taskId, { until: now() + holdMs, project: p.project, name: p.name });
    pending.delete(taskId);
    log(`crew-compact ${label}: /compact sent`);
  }

  async function tick(): Promise<void> {
    for (const [taskId, p] of [...pending]) {
      try { await tryOne(taskId, p); }
      catch (e) { log(`crew-compact ${p.project}:${p.name}: ${(e as Error).message}`); }
    }
  }

  return { request, tick, holdsCrew, compactDone, pendingCount: () => pending.size };
}
