// TaskRecord.task is a one-line title; the full brief lives in brief.md (claude
// crews) and the `task.dispatched` mailbox entry (every dispatch). Records written
// before the shrink still hold the full text in `task`, which stays a valid answer.

import fs from "node:fs";
import type { TaskRecord } from "@squadrant/shared";
import { briefPath, readInitPrompt } from "./first-turn-init.js";
import { buildCompletionProtocol } from "./crew-protocol.js";
import { frameFirstTurn } from "./squadrant-message.js";
import { readMailboxEntry } from "./mailbox.js";

export const TASK_TITLE_MAX_CHARS = 120;

/** First non-empty line of a brief, trimmed and capped. Idempotent, so it is also safe on an old full-text record. */
export function taskTitle(text: string | undefined): string {
  const line = (text ?? "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return line.trim().slice(0, TASK_TITLE_MAX_CHARS);
}

export type TaskBriefSource = "brief-file" | "mailbox" | "record";

function readBriefFile(stateRoot: string, rec: Pick<TaskRecord, "id" | "project">): string | undefined {
  try {
    return fs.readFileSync(briefPath(stateRoot, rec.project, rec.id), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The full brief of a task: brief.md, else the `task.dispatched` mailbox entry
 * (`briefSeq`), else `rec.task`. The last step is exact for an old record that
 * holds the full text; for a new record whose brief.md is gone (non-claude agent)
 * and whose mailbox segment rotated away, it is only the title, and `source`
 * says "record" so a caller that needs the whole text can tell.
 */
export async function readTaskBrief(
  stateRoot: string,
  rec: Pick<TaskRecord, "id" | "project" | "task" | "briefSeq">,
): Promise<{ text: string; source: TaskBriefSource }> {
  const file = readBriefFile(stateRoot, rec);
  if (file) return { text: file, source: "brief-file" };
  if (rec.briefSeq !== undefined) {
    try {
      const e = await readMailboxEntry(stateRoot, rec.project, rec.briefSeq);
      const brief = e?.taskId === rec.id && e.kind === "task.dispatched" ? e.payload?.brief : undefined;
      if (typeof brief === "string") return { text: brief, source: "mailbox" };
    } catch { /* fall through to the record */ }
  }
  return { text: rec.task, source: "record" };
}

/** Synchronous variant for render paths: brief.md, else `rec.task` (no mailbox lookup). */
export function readTaskBriefSync(stateRoot: string, rec: Pick<TaskRecord, "id" | "project" | "task">): string {
  return readBriefFile(stateRoot, rec) || rec.task;
}

/**
 * The first turn the #466 self-heal resends: the same init.md the crew was
 * launched with, else (older crews, a spawn that fell back to a first-turn send)
 * the framed brief plus completion protocol, with the brief read via readTaskBrief.
 */
export async function firstTurnResendMessage(
  stateRoot: string,
  rec: Pick<TaskRecord, "id" | "project" | "task" | "briefSeq" | "originProject">,
): Promise<string> {
  return readInitPrompt(stateRoot, rec.project, rec.id)
    ?? frameFirstTurn(
      `${(await readTaskBrief(stateRoot, rec)).text}\n\n${buildCompletionProtocol(rec.id, rec.project, "claude")}`,
      { project: rec.project, originProject: rec.originProject, taskId: rec.id },
    );
}
