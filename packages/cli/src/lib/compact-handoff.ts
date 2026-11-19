// #1010: after a Claude captain's context is compacted, hand it its own handoff
// back. Pure of daemon/IPC — reads the project's handoff files only.
import fs from "node:fs";
import path from "node:path";
import { workspacePath, CONFIG_DIR } from "@squadrant/shared";
import { readNewestArchivedHandoff } from "./handoff-archive.js";

export const COMPACT_NOTE = "Context was just compacted. This is your handoff; continue from nextSteps.";

/**
 * The text to inject on SessionStart(source=compact) for a captain, or "" when
 * nothing applies. Prefers the live `handoff.json` (the rollover skill just wrote
 * it and nothing has archived it yet), else the newest archived one — the same
 * selection `squadrant handoff facts` uses for its checkpoint.
 */
/** #1015: SessionStart(source=compact) for a captain session (not a crew). */
export function isCaptainCompactStart(payload: unknown, env: NodeJS.ProcessEnv, project: string | null | undefined): boolean {
  return (payload as { source?: unknown } | null)?.source === "compact"
    && env.SQUADRANT_ROLE === "captain" && !env.SQUADRANT_CREW_TASK_ID && !!project;
}

export function compactHandoffContext(
  payload: unknown,
  env: NodeJS.ProcessEnv,
  project: string | null | undefined,
  workspaceDir: (project: string) => string = workspacePath,
): string {
  if (!isCaptainCompactStart(payload, env, project) || !project) return "";
  const dir = workspaceDir(project);
  let handoff: string | null = null;
  try {
    handoff = fs.readFileSync(path.join(dir, "handoff.json"), "utf-8");
  } catch {
    const archived = readNewestArchivedHandoff(dir, Date.now(), false);
    if (archived) handoff = JSON.stringify(archived.content, null, 2);
  }
  if (!handoff) return "";
  return `${COMPACT_NOTE}\n\n<handoff project="${project}">\n${handoff.trim()}\n</handoff>`;
}

/**
 * #1109: skill text does not survive a compact, so a compacted captain gets the captain-ops core
 * (trigger table + core-only rules) back. Read at runtime from the synced plugin skill, the one source.
 * Fail-open: "" when the file is unreadable or this is not a captain compact start.
 */
export function compactCoreContext(
  payload: unknown,
  env: NodeJS.ProcessEnv,
  project: string | null | undefined,
  skillFile: string = path.join(CONFIG_DIR, "plugin", "skills", "captain-ops", "SKILL.md"),
): string {
  if (!isCaptainCompactStart(payload, env, project)) return "";
  try {
    const body = fs.readFileSync(skillFile, "utf-8").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    return body ? `${CORE_NOTE}\n\n<captain-ops>\n${body}\n</captain-ops>` : "";
  } catch {
    return "";
  }
}

export const CORE_NOTE = "Context was just compacted. This is your captain-ops core: read the reference file its trigger table names before each action.";

/** Fold extra context into a hook-output JSON string (or create one) so stdout stays a single JSON document. */
export function appendAdditionalContext(out: string, extra: string, hookEventName = "SessionStart"): string {
  if (!extra) return out;
  if (!out) return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: extra } });
  try {
    const o = JSON.parse(out);
    const prev = o?.hookSpecificOutput?.additionalContext;
    o.hookSpecificOutput = { ...o.hookSpecificOutput, additionalContext: prev ? `${prev}\n\n${extra}` : extra };
    return JSON.stringify(o);
  } catch {
    return out;
  }
}
