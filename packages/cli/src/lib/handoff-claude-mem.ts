// handoff-claude-mem.ts — #650 Phase 2: the "claude-mem" tier — distilled,
// pre-summarized project history, second in trust order after live repo
// state. Bounded by CLAUDE_MEM_RECENCY_LIMIT (most-recent-first, no full
// table scan) — the same recency discipline applied to the transcript tier.
// node:sqlite has no bare "sqlite" alias — a static `import ... from
// "node:sqlite"` gets its prefix stripped by esbuild's builtin-externalization
// pass (it doesn't recognize this still-experimental builtin), producing a
// runtime ERR_MODULE_NOT_FOUND for a nonexistent "sqlite" package. Routing
// through createRequire sidesteps static-import rewriting entirely.
import { createRequire } from "node:module";
import fs from "node:fs";
import type { ClaudeMemSummary } from "./handoff-facts.js";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export const CLAUDE_MEM_RECENCY_LIMIT = 20;

interface SummaryRow {
  request: string | null;
  completed: string | null;
  next_steps: string | null;
  created_at: string;
}

interface DecisionRow {
  title: string | null;
  narrative: string | null;
  facts: string | null;
  created_at: string;
}

function decisionText(row: DecisionRow): string {
  if (row.facts) {
    try {
      const parsed = JSON.parse(row.facts) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.join("; ");
    } catch {
      // fall through to narrative
    }
  }
  return row.narrative ?? "";
}

/** Read-only claude-mem query. Returns null only when the db itself can't be consulted. */
export function queryClaudeMem(dbPath: string, project: string): ClaudeMemSummary | null {
  if (!fs.existsSync(dbPath)) return null;

  let db: DatabaseSyncType;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    const summaryRow = db
      .prepare(
        `SELECT request, completed, next_steps, created_at FROM session_summaries
         WHERE project = ? ORDER BY created_at_epoch DESC LIMIT 1`,
      )
      .get(project) as unknown as SummaryRow | undefined;

    const decisionRows = db
      .prepare(
        `SELECT title, narrative, facts, created_at FROM observations
         WHERE project = ? AND type = 'decision' ORDER BY created_at_epoch DESC LIMIT ?`,
      )
      .all(project, CLAUDE_MEM_RECENCY_LIMIT) as unknown as DecisionRow[];

    const recentDecisions = decisionRows.map((r) => ({
      title: r.title,
      text: decisionText(r),
      createdAt: r.created_at,
    }));

    const candidates = [summaryRow?.created_at, ...decisionRows.map((r) => r.created_at)].filter(
      (v): v is string => !!v,
    );
    const oldestCreatedAt = candidates.length > 0 ? candidates.reduce((a, b) => (a < b ? a : b)) : null;

    return {
      latestSessionSummary: summaryRow
        ? {
            request: summaryRow.request,
            completed: summaryRow.completed,
            nextSteps: summaryRow.next_steps,
            createdAt: summaryRow.created_at,
          }
        : null,
      recentDecisions,
      oldestCreatedAt,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}
