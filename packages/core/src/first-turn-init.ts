// Launch-time init prompt for claude crews (spec 2026-10-26-first-turn-init-prompt).
// The brief is stored with the task in its per-task state dir (the same dir
// router-settings.json uses), never in the crew's worktree; init.md is what the
// pane's shell expands into claude's positional prompt arg at launch, so the
// first turn arrives as a real user turn instead of a peer message.

import fs from "node:fs";
import path from "node:path";
import { frameFirstTurn } from "./squadrant-message.js";

/**
 * Briefs at or under this size go inline in the init prompt; larger ones (and
 * every --task-file brief) become a "Read <path>" pointer. This is a
 * readability cut only, not a delivery limit: the init prompt reaches the agent
 * as a launch arg expanded by the shell, which has no paste limit (unlike the
 * pane path's FIRST_TURN_INLINE_MAX_BYTES), so one value fits every agent.
 */
export const INIT_PROMPT_INLINE_MAX_BYTES = 1200;

export function taskStateDir(stateRoot: string, project: string, taskId: string): string {
  return path.join(stateRoot, project, taskId);
}

/** Dir holding brief.md — claude gets it via --add-dir so the crew can Read it
 *  without a permission prompt; kept apart from the task dir's other files. */
export function briefDir(stateRoot: string, project: string, taskId: string): string {
  return path.join(taskStateDir(stateRoot, project, taskId), "brief");
}

export function briefPath(stateRoot: string, project: string, taskId: string): string {
  return path.join(briefDir(stateRoot, project, taskId), "brief.md");
}

export function initPromptPath(stateRoot: string, project: string, taskId: string): string {
  return path.join(taskStateDir(stateRoot, project, taskId), "init.md");
}

/** Text of the init prompt: the 📨 header, the brief inline or a Read pointer, then the completion protocol. */
export function buildInitPrompt(o: {
  brief: string;
  fromFile: boolean;
  briefPath: string;
  completionProtocol: string;
  project: string;
  taskId: string;
}): string {
  const inline = !o.fromFile && Buffer.byteLength(o.brief, "utf8") <= INIT_PROMPT_INLINE_MAX_BYTES;
  const body = inline ? o.brief : `Read ${o.briefPath} to get your task brief, then execute it.`;
  return frameFirstTurn(`${body}\n\n${o.completionProtocol}`, { project: o.project, taskId: o.taskId });
}

/** Writes brief.md (0600, verbatim) and init.md; returns their paths and the init text. */
export function writeInitPrompt(o: {
  stateRoot: string;
  project: string;
  taskId: string;
  brief: string;
  fromFile: boolean;
  completionProtocol: string;
}): { briefPath: string; briefDir: string; initPath: string; initText: string } {
  const dir = briefDir(o.stateRoot, o.project, o.taskId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bPath = briefPath(o.stateRoot, o.project, o.taskId);
  fs.writeFileSync(bPath, o.brief, { encoding: "utf8", mode: 0o600 });
  const initText = buildInitPrompt({ ...o, briefPath: bPath });
  const initPath = initPromptPath(o.stateRoot, o.project, o.taskId);
  fs.writeFileSync(initPath, initText, { encoding: "utf8", mode: 0o600 });
  return { briefPath: bPath, briefDir: dir, initPath, initText };
}

/** init.md for a task, or undefined when it was never written (pre-init crews, fallback spawns). */
export function readInitPrompt(stateRoot: string, project: string, taskId: string): string | undefined {
  try {
    return fs.readFileSync(initPromptPath(stateRoot, project, taskId), "utf8");
  } catch {
    return undefined;
  }
}
