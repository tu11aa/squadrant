// handoff-transcript.ts — #651: extract the tail of a KNOWN transcript file.
// Which file to read is resolved by the captain-session registry (ground
// truth recorded at SessionStart) — this module no longer picks "the
// newest" by mtime or content-sniffs for role; both were tried and both
// were wrong (mtime can grab an unrelated plain/crew session in the same
// project dir; content-sniffing is inference over a possibly-incomplete
// read). Transcript JSONL files can be multi-MB; this NEVER reads a whole
// file — only the last TRANSCRIPT_BYTE_CAP bytes.
import fs from "node:fs";
import type { TranscriptTail } from "./handoff-facts.js";

export const TRANSCRIPT_BYTE_CAP = 200_000;

interface TranscriptLine {
  type?: string;
  message?: { content?: unknown };
}

function tailOf(content: string, byteCap: number): string {
  const buf = Buffer.from(content, "utf-8");
  if (buf.length <= byteCap) return content;
  const text = buf.subarray(buf.length - byteCap).toString("utf-8");
  // Starting mid-file likely lands mid-line; that first fragment isn't valid JSON on its own.
  return text.split("\n").slice(1).join("\n");
}

function extractMessages(tailText: string): { lastUserMessage: string | null; lastAssistantText: string | null } {
  let lastUserMessage: string | null = null;
  let lastAssistantText: string | null = null;
  for (const line of tailText.split("\n")) {
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
  return { lastUserMessage, lastAssistantText };
}

/** Extract the last user/assistant message from a known transcript path, within a hard byte cap. Null if the path doesn't exist. */
export function extractTranscriptTail(transcriptPath: string, byteCap: number = TRANSCRIPT_BYTE_CAP): TranscriptTail | null {
  if (!fs.existsSync(transcriptPath)) return null;
  const content = fs.readFileSync(transcriptPath, "utf-8");
  const { lastUserMessage, lastAssistantText } = extractMessages(tailOf(content, byteCap));
  const mtimeIso = fs.statSync(transcriptPath).mtime.toISOString();
  return { path: transcriptPath, mtimeIso, lastUserMessage, lastAssistantText };
}
