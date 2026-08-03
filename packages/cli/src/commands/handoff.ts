// handoff.ts — `squadrant handoff facts <project>` (#650/#651).
//
// Gathers verified FACTS from trust-ordered/ground-truth sources — gh API
// (always fresh) > local git (marked with fetch age) > claude-mem
// (distilled, can be stale) — plus a CHECKPOINT (the newest archived
// handoff, read in full — it already covers history up to the moment it
// was written) and the GAP (captain sessions that started after it,
// attributed via the registry rather than guessed from file mtimes or
// content-sniffed for role — that's the work no handoff covers, and the
// only transcripts actually read). Emits everything grouped by source with
// provenance. Does NOT author a handoff: no currentState/nextSteps/
// decisions synthesis. Composing the actual handoff from these facts is
// judgment and belongs to whoever reads them (the captain). Read-only and
// side-effect-free — safe for #641's `squadrant brief` to call as one
// source among several, and safe to call repeatedly.
import { Command } from "commander";
import path from "node:path";
import os from "node:os";
import { loadConfig, resolveWorktreeBase } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";
import { squadrantdCall } from "./crew-control.js";
import { gatherLiveRepoState, defaultCommandRunner } from "../lib/handoff-live-repo.js";
import type { CommandRunner } from "../lib/handoff-live-repo.js";
import { queryClaudeMem } from "../lib/handoff-claude-mem.js";
import { extractTranscriptTail } from "../lib/handoff-transcript.js";
import { readNewestArchivedHandoff } from "../lib/handoff-archive.js";
import { readCaptainSessionRegistry, selectGapSessions } from "../lib/captain-session-registry.js";
import { assembleHandoffFacts, SESSION_WINDOW_MS } from "../lib/handoff-facts.js";
import type { HandoffFacts, SessionWithTranscript } from "../lib/handoff-facts.js";

const CLAUDE_MEM_DB_PATH = path.join(os.homedir(), ".claude-mem", "claude-mem.db");

async function defaultFetchTasks(project: string): Promise<TaskRecord[]> {
  return (await squadrantdCall({ kind: "list", project })) as TaskRecord[];
}

export interface HandoffFactsDeps {
  claudeMemDbPath?: string;
  now?: string;
  windowMs?: number;
  /** The running session's own id (CLAUDE_CODE_SESSION_ID) — excludes it from the window by identity, never by mtime. `undefined` reads the real env var; pass `null` explicitly to simulate "unknown". */
  currentSessionId?: string | null;
  fetchTasks?: (project: string) => Promise<TaskRecord[]>;
  runner?: CommandRunner;
}

export async function runHandoffFacts(project: string, deps: HandoffFactsDeps = {}): Promise<HandoffFacts> {
  const config = loadConfig();
  const proj = config.projects[project];
  if (!proj) {
    throw new Error(`Project '${project}' not found. Run 'squadrant projects list'.`);
  }

  // Only used when gh is entirely unavailable — gatherLiveRepoState prefers
  // the gh API's default-branch answer (always fresh, no fetch needed).
  const fallbackBaseBranch = resolveWorktreeBase(proj.path);

  let tasks: TaskRecord[];
  try {
    tasks = await (deps.fetchTasks ?? defaultFetchTasks)(project);
  } catch {
    // Daemon unreachable or an injected source failed — degrade to no
    // live-crew data rather than fail the whole gather.
    tasks = [];
  }

  const nowIso = deps.now ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const fallbackWindowMs = deps.windowMs ?? SESSION_WINDOW_MS;

  const live = gatherLiveRepoState(proj.path, fallbackBaseBranch, tasks, deps.runner ?? defaultCommandRunner, nowMs);
  const claudeMem = queryClaudeMem(deps.claudeMemDbPath ?? CLAUDE_MEM_DB_PATH, project);

  const checkpoint = readNewestArchivedHandoff(proj.spokeVault, nowMs);

  const currentSessionId = deps.currentSessionId !== undefined ? deps.currentSessionId : (process.env.CLAUDE_CODE_SESSION_ID ?? null);

  let registryNote: string | null = null;
  let gapSessions: SessionWithTranscript[] = [];
  let usedFallbackWindow = false;
  if (currentSessionId === null) {
    // Can't safely tell which registered session (if any) is "self" — the
    // exact self-read #650 originally hit. Skip the gap rather than risk it.
    registryNote = "current session id unknown (CLAUDE_CODE_SESSION_ID unset) — cannot safely exclude the running session, so the gap was skipped";
  } else {
    const allRecords = readCaptainSessionRegistry(proj.spokeVault);
    if (allRecords.length === 0) {
      registryNote = "no session registry found yet for this project (#651's SessionStart hook may not have fired before now)";
    }
    const selection = selectGapSessions(allRecords, currentSessionId, checkpoint, nowMs, fallbackWindowMs);
    usedFallbackWindow = selection.usedFallbackWindow;
    // Only the gap's transcripts are ever read — sessions before the
    // checkpoint are already covered by it, so re-reading them is exactly
    // the wasted work #651's correction exists to avoid.
    gapSessions = selection.gapSessions.map((session) => ({ session, transcript: extractTranscriptTail(session.transcriptPath) }));
  }

  return assembleHandoffFacts(live, claudeMem, gapSessions, checkpoint, nowIso, {
    registryNote,
    usedFallbackWindow,
    fallbackWindowMs,
  });
}

export const handoffCommand = new Command("handoff").description(
  "Handoff continuity — gather verified facts for the captain to synthesize a handoff from (#650/#651)",
);

handoffCommand
  .command("facts <project>")
  .description(
    "Gather structured facts (gh API > local git > claude-mem > registry-attributed session window) — NOT a handoff. Read-only, pre-rendered JSON on stdout; the caller synthesizes.",
  )
  .action(async (project: string) => {
    const out = await runHandoffFacts(project);
    console.log(JSON.stringify(out, null, 2));
  });
