// #1010: `squadrant captain compact` — queue a /compact for a Claude captain and
// type it into the pane only once the captain is idle. Claude Code has no API to
// compact itself and the peer socket can't run slash commands, so this goes
// through the pane, behind the same send guard as every other pane delivery
// (draft / modal / no-box all defer via DeferDelivery).
import { loadConfig } from "@squadrant/shared";
import type { PaneRef } from "@squadrant/shared";
import type { DaemonSurfaceDriver } from "../interfaces.js";
import { DeferDelivery } from "../delivery/defer-delivery.js";
import { discoverCaptainSurface } from "./delivery-loop.js";

/** A live Claude Code turn shows a working spinner (token counter, "esc to interrupt",
 *  shell-wait hint, elapsed timer). Shared with the startup-surface classifier. */
export const CC_WORKING_RE = /↓\s*[\d.]+\s*k?\s*tokens?\b|esc to interrupt|\bshell still running\b|·\s*\d+\s*shell\b|\(\d+m?\s*\d*s\b/i;

export const DEFAULT_COMPACT_FOCUS =
  "Keep the active task, open PRs/crews and decisions; the full state is in the handoff";
export const COMPACT_TIMEOUT_MS = 10 * 60_000;
/** Consecutive idle polls required before typing — rides out a flicker between tool calls. */
const IDLE_POLLS = 2;

interface Pending { focus: string; deadline: number; idlePolls: number; lastReason?: string }

export interface CaptainCompactDeps {
  cmux: DaemonSurfaceDriver;
  log: (line: string) => void;
  now?: () => number;
  timeoutMs?: number;
  /** Fallback surfaces when workspace discovery finds nothing (tests / config-less projects). */
  injectedSurfaces?: Record<string, PaneRef>;
  /** Override for tests; defaults to the loaded config's captain title. */
  captainTitle?: (project: string) => string;
}

export function createCaptainCompact(deps: CaptainCompactDeps) {
  const { cmux, log } = deps;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? COMPACT_TIMEOUT_MS;
  const pending = new Map<string, Pending>();

  const titleFor = (project: string): string => {
    if (deps.captainTitle) return deps.captainTitle(project);
    const cfg = loadConfig();
    return project === cfg.commandName ? cfg.commandName : (cfg.projects?.[project]?.captainName ?? `${project}-captain`);
  };

  async function resolveSurface(project: string): Promise<PaneRef | null> {
    const title = titleFor(project);
    const wsId = cmux.findWorkspaceId ? await cmux.findWorkspaceId(title) : null;
    if (!wsId) return deps.injectedSurfaces?.[project] ?? null;
    return discoverCaptainSurface(await cmux.listSurfaces(wsId), title) ?? deps.injectedSurfaces?.[project] ?? null;
  }

  /** Queue (or re-arm) a compact for the project's captain; returns immediately. */
  function request(project: string, focus?: string): { queued: true } {
    pending.set(project, { focus: focus?.trim() || DEFAULT_COMPACT_FOCUS, deadline: now() + timeoutMs, idlePolls: 0 });
    log(`captain-compact ${project}: queued, waiting for idle captain`);
    return { queued: true };
  }

  async function tryOne(project: string, p: Pending): Promise<void> {
    if (now() > p.deadline) {
      pending.delete(project);
      log(`captain-compact ${project}: timed out after ${Math.round(timeoutMs / 1000)}s waiting for an idle captain (last: ${p.lastReason ?? "busy"}) — not compacted`);
      return;
    }
    const surface = await resolveSurface(project);
    if (!surface) { p.lastReason = "no-surface"; return; }
    const screen = await cmux.readPaneScreen(surface);
    if (screen == null || CC_WORKING_RE.test(screen)) {
      p.idlePolls = 0;
      p.lastReason = screen == null ? "unreadable" : "turn-in-flight";
      return;
    }
    if (++p.idlePolls < IDLE_POLLS) return;
    try {
      await cmux.send(surface, `/compact ${p.focus}`, { agent: "claude" });
    } catch (e) {
      if (!(e instanceof DeferDelivery)) throw e;
      p.idlePolls = 0;
      p.lastReason = e.reason;
      return;
    }
    pending.delete(project);
    log(`captain-compact ${project}: /compact sent`);
  }

  async function tick(): Promise<void> {
    for (const [project, p] of [...pending]) {
      try { await tryOne(project, p); }
      catch (e) { log(`captain-compact ${project}: ${(e as Error).message}`); }
    }
  }

  return { request, tick, pendingCount: () => pending.size };
}
