import { TERMINAL_STATES } from "@squadrant/shared";
import type { ContextBudget, TaskState } from "@squadrant/shared";
import { formatContext } from "./context-meter.js";

/**
 * #1015 boundary-based rollover suggestions for the captain. SUGGEST / WARN
 * ONLY — nothing here compacts, types `/compact`, or touches a session
 * (operator decision, profile prof.never-auto-compact).
 *
 * Soft suggestion: fires once per boundary when captain context ≥ captainSoft,
 * nothing is waiting on the captain, and context grew ≥ SOFT_REGROW since the
 * last suggestion. Hard warning: needs no boundary, repeats every HARD_REGROW.
 */

export const SOFT_REGROW = 50_000;
export const HARD_REGROW = 100_000;
/** A boundary nobody could act on (suppressed the whole time) goes stale. */
export const BOUNDARY_TTL_MS = 30 * 60 * 1000;

export type BoundaryKind = "crew done" | "crew closed" | "crew question answered";

/** Pure. The boundary (if any) a task state transition constitutes. */
export function boundaryOf(before: TaskState | undefined, after: TaskState | undefined): BoundaryKind | null {
  if (!before || !after || before === after) return null;
  if (after === "done") return "crew done";
  if (after === "cancelled") return "crew closed";
  if (before === "blocked" && !TERMINAL_STATES.has(after)) return "crew question answered";
  return null;
}

export interface AdvisorState {
  boundary: { kind: BoundaryKind; at: number } | null;
  /** Context at the last soft suggestion / hard warning; null = none since the last reset. */
  softAt: number | null;
  hardAt: number | null;
}

export const emptyAdvisorState = (): AdvisorState => ({ boundary: null, softAt: null, hardAt: null });

export interface AdvisorInput {
  now: number;
  tokens: number | null;
  budget: ContextBudget;
  /** A crew is blocked on a question to the captain. */
  openQuestion: boolean;
  /** The captain mailbox has entries not yet delivered. */
  mailboxBacklog: boolean;
}

export interface AdvisorDecision {
  state: AdvisorState;
  /** One line for the captain pane, or null. */
  message: string | null;
}

/** Pure. */
export function decideContextAdvice(prev: AdvisorState, input: AdvisorInput): AdvisorDecision {
  const { now, tokens, budget } = input;
  let state: AdvisorState = { ...prev };
  if (state.boundary && now - state.boundary.at > BOUNDARY_TTL_MS) state.boundary = null;
  if (!budget.enabled || tokens === null) return { state, message: null };

  // Context shrank below the last mark: a rollover/compact happened, start over.
  if (state.softAt !== null && tokens < state.softAt) state.softAt = null;
  if (state.hardAt !== null && tokens < state.hardAt) state.hardAt = null;

  if (tokens >= budget.captainHard && (state.hardAt === null || tokens >= state.hardAt + HARD_REGROW)) {
    state = { ...state, hardAt: tokens, softAt: tokens, boundary: null };
    return {
      state,
      message:
        `⚠ Context ${formatContext(tokens)} ≥ hard limit ${formatContext(budget.captainHard)}. ` +
        `Every call re-reads it. Write the handoff, then /squadrant:rollover at the next safe point. ` +
        `(Warning only: nothing is compacted automatically.)`,
    };
  }

  const b = state.boundary;
  if (!b) return { state, message: null };
  // Below the soft floor there is nothing to suggest; at/above the hard limit only the (rate-limited) hard warning speaks.
  if (tokens < budget.captainSoft || tokens >= budget.captainHard) return { state: { ...state, boundary: null }, message: null };
  if (input.openQuestion || input.mailboxBacklog) return { state, message: null }; // keep the boundary, retry
  if (state.softAt !== null && tokens < state.softAt + SOFT_REGROW) return { state: { ...state, boundary: null }, message: null };

  return {
    state: { ...state, boundary: null, softAt: tokens },
    message:
      `Context ${formatContext(tokens)} ≥ ${formatContext(budget.captainSoft)} at a boundary (${b.kind}). ` +
      `Good moment: write the handoff, then /squadrant:rollover.`,
  };
}

export interface ContextAdvisorDeps {
  now: () => number;
  budgetFor: (project: string) => ContextBudget;
  /** Captain context tokens, or null when unmeasurable. */
  captainTokens: (project: string) => number | null;
  hasOpenQuestion: (project: string) => boolean;
  mailboxBacklog: (project: string) => Promise<boolean>;
  /** Append one line to the captain mailbox. */
  enqueue: (project: string, text: string) => Promise<unknown>;
  log?: (m: string) => void;
}

export interface ContextAdvisor {
  noteBoundary(project: string, kind: BoundaryKind): void;
  tick(projects: readonly string[]): Promise<void>;
}

export function createContextAdvisor(deps: ContextAdvisorDeps): ContextAdvisor {
  const states = new Map<string, AdvisorState>();
  const get = (p: string) => states.get(p) ?? emptyAdvisorState();
  return {
    noteBoundary(project, kind) {
      states.set(project, { ...get(project), boundary: { kind, at: deps.now() } });
    },
    async tick(projects) {
      for (const project of projects) {
        try {
          const budget = deps.budgetFor(project);
          if (!budget.enabled) continue;
          const prev = get(project);
          const tokens = deps.captainTokens(project);
          // Backlog is only consulted when a soft suggestion could fire — keeps idle ticks I/O-free.
          const soft = prev.boundary !== null && tokens !== null && tokens >= budget.captainSoft;
          const d = decideContextAdvice(prev, {
            now: deps.now(), tokens, budget,
            openQuestion: soft ? deps.hasOpenQuestion(project) : false,
            mailboxBacklog: soft ? await deps.mailboxBacklog(project) : false,
          });
          states.set(project, d.state);
          if (d.message) await deps.enqueue(project, d.message);
        } catch (e) {
          deps.log?.(`context advisor ${project}: ${(e as Error).message}`);
        }
      }
    },
  };
}
