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
/** #1015: how long after `/compact` is typed we keep holding delivery waiting for the
 *  SessionStart(source=compact) hook. If it never arrives the hold lapses on its own. */
export const COMPACT_HOLD_MS = 3 * 60_000;
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
  /** #1015: undelivered mailbox entries for the project. A compact waits for 0 so no
   *  message is ever in flight across the compact boundary. Absent ⇒ not consulted. */
  undeliveredCount?: (project: string) => Promise<number>;
  /** #1015/#1034: true while the delivery loop is mid-pass for this project (it may be about to type). */
  deliveryBusy?: (project: string) => boolean;
  holdMs?: number;
  /** #1038: right after `/compact` is typed, queue the "continue" message to the captain's peer
   *  channel (Claude Code holds it until the compact ends) — `/compact` is a local command, so
   *  nothing else starts a turn afterwards. Absent ⇒ no resume message. */
  resume?: (project: string) => Promise<void>;
}

/** #1038: the captain message that starts the post-compact turn. */
export const COMPACT_RESUME_TEXT = "Compact finished — continue from the handoff nextSteps.";

export function createCaptainCompact(deps: CaptainCompactDeps) {
  const { cmux, log } = deps;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? COMPACT_TIMEOUT_MS;
  const holdMs = deps.holdMs ?? COMPACT_HOLD_MS;
  const pending = new Map<string, Pending>();
  /** #1015: projects whose delivery is frozen — from the moment the idle check passes until
   *  the post-compact SessionStart hook (or `until`) ends the window. */
  const holds = new Map<string, { until: number }>();

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

  /** #1015: delivery must not type or send for this project while this is true. */
  function holdsDelivery(project: string): boolean {
    const h = holds.get(project);
    if (!h) return false;
    if (now() <= h.until) return true;
    holds.delete(project);
    log(`captain-compact ${project}: hold lapsed (no SessionStart(compact) within ${Math.round(holdMs / 1000)}s) — delivery resumed`);
    return false;
  }

  /** #1015: SessionStart(source=compact) arrived for this captain — the window is over. */
  function compactDone(project: string): void {
    if (holds.delete(project)) log(`captain-compact ${project}: compact finished — delivery resumed`);
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
    // #1015: never let a message be in flight across the compact. Wait for the durable
    // backlog to drain (delivery is still running), then freeze delivery synchronously —
    // no await between the final check and setting the hold — and re-verify.
    if (deps.undeliveredCount && (await deps.undeliveredCount(project)) > 0) {
      p.idlePolls = 0;
      p.lastReason = "undelivered-mail";
      return;
    }
    holds.set(project, { until: now() + holdMs });
    if (deps.deliveryBusy?.(project)) {
      // #1034: keep idlePolls — the captain is idle; retry on the next tick.
      holds.delete(project);
      p.lastReason = "delivery-in-flight";
      return;
    }
    try {
      await cmux.send(surface, `/compact ${p.focus}`, { agent: "claude" });
    } catch (e) {
      holds.delete(project);
      if (!(e instanceof DeferDelivery)) throw e;
      p.idlePolls = 0;
      p.lastReason = e.reason;
      return;
    }
    // Restart the window from the actual send; the hold persists until compactDone.
    holds.set(project, { until: now() + holdMs });
    pending.delete(project);
    log(`captain-compact ${project}: /compact sent`);
    // Only compacts squadrant queued reach here; a hand-typed /compact never does.
    deps.resume?.(project).catch((e: unknown) => log(`captain-compact ${project}: resume message failed: ${(e as Error).message}`));
  }

  // The daemon fires tick() every 1s without awaiting it, and cmux.send can take longer than
  // that: an overlapping tick would re-run the same pending entry and type /compact twice.
  let ticking = false;
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      for (const [project, p] of [...pending]) {
        try { await tryOne(project, p); }
        catch (e) { log(`captain-compact ${project}: ${(e as Error).message}`); }
      }
    } finally { ticking = false; }
  }

  return { request, tick, holdsDelivery, compactDone, pendingCount: () => pending.size };
}
