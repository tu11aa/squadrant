// handoff.ts — `squadrant handoff reconstruct <project>` (#650 Phase 2).
//
// Rebuilds a handoff when read-handoff.sh reports {"exists": false}, from
// three trust-ordered sources: live repo state (git/gh/live crews, exact and
// current) > claude-mem (distilled, can be stale) > transcript (inference).
// Read-only and side-effect-free — safe for #641's `squadrant brief` to call
// as one source among several, and safe to call repeatedly.
import { Command } from "commander";
import path from "node:path";
import os from "node:os";
import { loadConfig, resolveWorktreeBase } from "@squadrant/shared";
import type { TaskRecord } from "@squadrant/shared";
import { squadrantdCall } from "./crew-control.js";
import { CLAUDE_PROJECTS_DIR } from "./tokens.js";
import { gatherLiveRepoState, defaultCommandRunner } from "../lib/handoff-live-repo.js";
import type { CommandRunner } from "../lib/handoff-live-repo.js";
import { queryClaudeMem } from "../lib/handoff-claude-mem.js";
import { readNewestTranscriptTail } from "../lib/handoff-transcript.js";
import { reconstructHandoff } from "../lib/handoff-reconstruct.js";
import type { ReconstructedHandoff } from "../lib/handoff-reconstruct.js";

const CLAUDE_MEM_DB_PATH = path.join(os.homedir(), ".claude-mem", "claude-mem.db");

async function defaultFetchTasks(project: string): Promise<TaskRecord[]> {
  return (await squadrantdCall({ kind: "list", project })) as TaskRecord[];
}

export interface HandoffReconstructDeps {
  claudeMemDbPath?: string;
  claudeProjectsDir?: string;
  now?: string;
  fetchTasks?: (project: string) => Promise<TaskRecord[]>;
  runner?: CommandRunner;
}

/** Escapes a cwd into Claude Code's ~/.claude/projects/<slug> directory naming. */
function slugForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export async function runHandoffReconstruct(
  project: string,
  deps: HandoffReconstructDeps = {},
): Promise<ReconstructedHandoff> {
  const config = loadConfig();
  const proj = config.projects[project];
  if (!proj) {
    throw new Error(`Project '${project}' not found. Run 'squadrant projects list'.`);
  }

  const baseBranch = resolveWorktreeBase(proj.path);

  let tasks: TaskRecord[];
  try {
    tasks = await (deps.fetchTasks ?? defaultFetchTasks)(project);
  } catch {
    // Daemon unreachable or an injected source failed — degrade to no
    // live-crew data rather than fail the whole reconstruction.
    tasks = [];
  }

  const live = gatherLiveRepoState(proj.path, baseBranch, tasks, deps.runner ?? defaultCommandRunner);
  const claudeMem = queryClaudeMem(deps.claudeMemDbPath ?? CLAUDE_MEM_DB_PATH, project);
  const transcriptDir = path.join(deps.claudeProjectsDir ?? CLAUDE_PROJECTS_DIR, slugForCwd(proj.path));
  const transcript = readNewestTranscriptTail(transcriptDir);

  return reconstructHandoff(live, claudeMem, transcript, deps.now ?? new Date().toISOString());
}

export const handoffCommand = new Command("handoff").description(
  "Handoff continuity — reconstruct a handoff when none exists (#650)",
);

handoffCommand
  .command("reconstruct <project>")
  .description(
    "Reconstruct a handoff from live repo state > claude-mem > transcript (trust order). Read-only, pre-rendered JSON on stdout.",
  )
  .action(async (project: string) => {
    const out = await runHandoffReconstruct(project);
    console.log(JSON.stringify(out, null, 2));
  });
