import type { ContextBudget, TaskRecord } from "@squadrant/shared";
import { formatContext } from "./context-meter.js";

/**
 * #1126 warm-compact nudge. One captain line per idle period when an idle crew's
 * prompt cache is about to expire while its context is large: compacting now reads a
 * warm cache; after expiry the next send rewrites the whole context. NUDGE ONLY —
 * nothing here compacts, types `/compact`, or touches a session (operator decision,
 * profile prof.never-auto-compact).
 */

/** Assumed prompt-cache TTL. Past it the cache is already cold and the nudge has no point. */
export const CACHE_TTL_MIN = 60;
/** Idle = the crew's turn ended and it waits on the captain (not mid-turn, not blocked on a question). */
const IDLE_STATES = new Set<string>(["awaiting-input", "review", "done"]);
/** Agents `crew compact` accepts (codex/gemini crews are refused). */
const COMPACTABLE = new Set<string>(["claude", "opencode"]);

/** Pure. Whole minutes idle when the crew is a nudge candidate (idle window open, compactable, not held), else null. */
export function warmIdleMinutes(t: TaskRecord, now: number, budget: ContextBudget): number | null {
  if (!budget.enabled || !budget.warmNudge) return null;
  if (!IDLE_STATES.has(t.state) || t.operatorHold || !COMPACTABLE.has(t.provider)) return null;
  const idleMin = Math.floor((now - t.lastHeartbeat) / 60_000);
  return idleMin >= budget.warmNudgeIdleMin && idleMin < CACHE_TTL_MIN ? idleMin : null;
}

/** Pure. The one captain line. */
export function warmNudgeMessage(project: string, name: string, idleMin: number, tokens: number): string {
  return (
    `crew ${name} idle ${idleMin}m at ${formatContext(tokens)} ctx; its cache expires in ~${CACHE_TTL_MIN - idleMin}m. ` +
    `More work on its track? \`squadrant crew compact ${project} ${name} --keep '…'\` now. ` +
    `Otherwise let it go cold, or close it once pushed.`
  );
}

export interface WarmNudgerDeps {
  now: () => number;
  budgetFor: (project: string) => ContextBudget;
  tasks: (project: string) => TaskRecord[];
  /** Live context tokens of a crew, or null when unmeasurable (non-claude agents). */
  crewTokens: (t: TaskRecord) => number | null;
  /** The crew still has a live pane. A closed crew keeps its `done` record, so state alone cannot tell. */
  hasLiveSurface: (project: string, name: string) => Promise<boolean>;
  /** Append one line to the captain mailbox. */
  enqueue: (project: string, text: string) => Promise<unknown>;
  log?: (m: string) => void;
}

export interface WarmNudger {
  tick(projects: readonly string[]): Promise<void>;
}

export function createWarmNudger(deps: WarmNudgerDeps): WarmNudger {
  /** task id → lastHeartbeat when nudged. Any activity (or a compact) moves lastHeartbeat, which re-arms. */
  const nudged = new Map<string, number>();
  return {
    async tick(projects) {
      for (const project of projects) {
        try {
          const budget = deps.budgetFor(project);
          const now = deps.now();
          // Only the crew's live record: the newest task per name.
          const latest = new Map<string, TaskRecord>();
          for (const t of deps.tasks(project)) {
            const k = t.name ?? t.id;
            if ((latest.get(k)?.createdAt ?? -1) < t.createdAt) latest.set(k, t);
          }
          for (const t of latest.values()) {
            if (nudged.has(t.id) && nudged.get(t.id) !== t.lastHeartbeat) nudged.delete(t.id);
            if (nudged.has(t.id)) continue;
            const idleMin = warmIdleMinutes(t, now, budget);
            if (idleMin === null) continue;
            const tokens = deps.crewTokens(t);
            if (tokens === null || tokens < budget.warmNudgeCtx) continue;
            if (!t.name || !(await deps.hasLiveSurface(project, t.name))) continue;
            nudged.set(t.id, t.lastHeartbeat);
            await deps.enqueue(project, warmNudgeMessage(project, t.name ?? t.id, idleMin, tokens));
          }
        } catch (e) {
          deps.log?.(`warm nudge ${project}: ${(e as Error).message}`);
        }
      }
    },
  };
}
