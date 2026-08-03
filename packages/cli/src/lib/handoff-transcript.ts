// handoff-transcript.ts — #650 Phase 2: the "transcript" tier — the newest
// captain session transcript, used only as inference when claude-mem has
// nothing (lowest trust tier). Transcript JSONL files can be multi-MB; this
// NEVER reads a whole file — only the last TRANSCRIPT_BYTE_CAP bytes of the
// single newest file (never globs/replays all of them).
import fs from "node:fs";
import path from "node:path";
import type { TranscriptTail } from "./handoff-reconstruct.js";

export const TRANSCRIPT_BYTE_CAP = 200_000;

interface TranscriptLine {
  type?: string;
  message?: { content?: unknown };
}

function findNewestJsonl(dir: string): { file: string; mtime: Date } | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".jsonl"));
  if (entries.length === 0) return null;
  let newest: { file: string; mtime: Date } | null = null;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const mtime = fs.statSync(full).mtime;
    if (!newest || mtime.getTime() > newest.mtime.getTime()) newest = { file: full, mtime };
  }
  return newest;
}

function readTail(file: string, byteCap: number): string {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - byteCap);
  const length = size - start;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString("utf-8");
  // A non-zero start likely lands mid-line; that first fragment isn't valid
  // JSON on its own and is dropped rather than risk parsing garbage.
  const lines = text.split("\n");
  return (start > 0 ? lines.slice(1) : lines).join("\n");
}

/**
 * Find the newest *.jsonl transcript in `dir` and extract the last user
 * message and last assistant text within a hard byte cap. Returns null if
 * the directory or any transcript is missing — this tier is optional.
 */
export function readNewestTranscriptTail(dir: string, byteCap: number = TRANSCRIPT_BYTE_CAP): TranscriptTail | null {
  if (!fs.existsSync(dir)) return null;
  const newest = findNewestJsonl(dir);
  if (!newest) return null;

  const tail = readTail(newest.file, byteCap);

  let lastUserMessage: string | null = null;
  let lastAssistantText: string | null = null;
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    let obj: TranscriptLine;
    try {
      obj = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (obj.type === "user" && typeof obj.message?.content === "string") {
      lastUserMessage = obj.message.content;
    } else if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const texts = (obj.message.content as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string);
      if (texts.length > 0) lastAssistantText = texts.join("\n");
    }
  }

  return { path: newest.file, mtimeIso: newest.mtime.toISOString(), lastUserMessage, lastAssistantText };
}
