// handoff-transcript.ts — #651: extract the tail of a KNOWN transcript file.
// Which file to read is resolved by the captain-session registry (ground
// truth recorded at SessionStart) — this module no longer picks "the
// newest" by mtime or content-sniffs for role; both were tried and both
// were wrong (mtime can grab an unrelated plain/crew session in the same
// project dir; content-sniffing is inference over a possibly-incomplete
// read). Transcript JSONL files can be multi-MB; this NEVER reads a whole
// file — only the last TRANSCRIPT_BYTE_CAP bytes.
import fs from "node:fs";
import type { TranscriptTail, TranscriptDigest } from "./handoff-facts.js";

export const TRANSCRIPT_BYTE_CAP = 200_000;

/** Hard cap on the serialized digest (#753) — keeps the startup prefix small even for a long gap session. */
export const DIGEST_BYTE_CAP = 8 * 1024;

const PROMPT_TRUNCATE_CHARS = 300;
const ASSISTANT_TRUNCATE_CHARS = 300;

interface TranscriptLine {
  type?: string;
  message?: { content?: unknown };
}

interface AssistantContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`;
}

const ISSUE_OR_PR_REF_RE = /#\d+/g;
// Commit-SHA-looking tokens: hex, 7-40 chars, with at least one digit AND one
// a-f letter — filters out plain hex-only words and plain numbers.
const COMMIT_REF_RE = /\b[0-9a-f]{7,40}\b/gi;

function findRefs(text: string): string[] {
  const refs: string[] = [];
  for (const m of text.matchAll(ISSUE_OR_PR_REF_RE)) refs.push(m[0]);
  for (const m of text.matchAll(COMMIT_REF_RE)) {
    const token = m[0];
    if (/[0-9]/.test(token) && /[a-f]/i.test(token)) refs.push(token.toLowerCase());
  }
  return refs;
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf-8");
}

/** Drops oldest prompts/turns first (then files/refs) until the digest fits DIGEST_BYTE_CAP. Recent context matters more than old. */
function capDigest(digest: TranscriptDigest, capBytes: number = DIGEST_BYTE_CAP): TranscriptDigest {
  if (byteSize(digest) <= capBytes) return digest;
  const capped: TranscriptDigest = {
    ...digest,
    userPrompts: [...digest.userPrompts],
    assistantTexts: [...digest.assistantTexts],
    filesTouched: [...digest.filesTouched],
    refs: [...digest.refs],
    truncated: true,
  };
  let dropFromPrompts = true;
  while (byteSize(capped) > capBytes && (capped.userPrompts.length > 0 || capped.assistantTexts.length > 0)) {
    const target = dropFromPrompts && capped.userPrompts.length > 0 ? capped.userPrompts : capped.assistantTexts;
    if (target.length > 0) target.shift();
    dropFromPrompts = !dropFromPrompts;
  }
  while (byteSize(capped) > capBytes && (capped.filesTouched.length > 0 || capped.refs.length > 0)) {
    if (capped.filesTouched.length > 0) capped.filesTouched.shift();
    else capped.refs.shift();
  }
  return capped;
}

function tailOf(content: string, byteCap: number): string {
  const buf = Buffer.from(content, "utf-8");
  if (buf.length <= byteCap) return content;
  const text = buf.subarray(buf.length - byteCap).toString("utf-8");
  // Starting mid-file likely lands mid-line; that first fragment isn't valid JSON on its own.
  return text.split("\n").slice(1).join("\n");
}

/** Walks a transcript tail once, building both the legacy last-message fields and the bounded digest (#753). */
function extractMessages(tailText: string): { lastUserMessage: string | null; lastAssistantText: string | null; digest: TranscriptDigest } {
  let lastUserMessage: string | null = null;
  let lastAssistantText: string | null = null;
  const userPrompts: string[] = [];
  const assistantTexts: string[] = [];
  const toolCalls: Record<string, number> = {};
  const filesTouched = new Set<string>();
  const refs = new Set<string>();
  // The current turn's assistant text, flushed into assistantTexts when the
  // next real (string-content) user prompt starts a new turn.
  let currentTurnText: string | null = null;

  const collectRefs = (text: string) => {
    for (const ref of findRefs(text)) refs.add(ref);
  };

  for (const line of tailText.split("\n")) {
    if (!line.trim()) continue;
    let obj: TranscriptLine;
    try {
      obj = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (obj.type === "user" && typeof obj.message?.content === "string") {
      if (currentTurnText !== null) {
        assistantTexts.push(truncate(currentTurnText, ASSISTANT_TRUNCATE_CHARS));
        currentTurnText = null;
      }
      lastUserMessage = obj.message.content;
      userPrompts.push(truncate(obj.message.content, PROMPT_TRUNCATE_CHARS));
      collectRefs(obj.message.content);
    } else if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const blocks = obj.message.content as AssistantContentBlock[];
      const texts = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
      if (texts.length > 0) {
        currentTurnText = texts.join("\n");
        lastAssistantText = currentTurnText;
        collectRefs(currentTurnText);
      }
      for (const block of blocks) {
        if (block.type !== "tool_use" || typeof block.name !== "string") continue;
        toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
        const filePath = block.input?.file_path;
        if (typeof filePath === "string") filesTouched.add(filePath);
      }
    }
  }
  if (currentTurnText !== null) {
    assistantTexts.push(truncate(currentTurnText, ASSISTANT_TRUNCATE_CHARS));
  }

  const digest = capDigest({
    userPrompts,
    assistantTexts,
    toolCalls,
    filesTouched: [...filesTouched],
    refs: [...refs],
    truncated: false,
  });

  return { lastUserMessage, lastAssistantText, digest };
}

/** Extract a bounded digest (plus the legacy last user/assistant message) from a known transcript path, within a hard byte cap. Null if the path doesn't exist. */
export function extractTranscriptTail(transcriptPath: string, byteCap: number = TRANSCRIPT_BYTE_CAP): TranscriptTail | null {
  if (!fs.existsSync(transcriptPath)) return null;
  const content = fs.readFileSync(transcriptPath, "utf-8");
  const { lastUserMessage, lastAssistantText, digest } = extractMessages(tailOf(content, byteCap));
  const mtimeIso = fs.statSync(transcriptPath).mtime.toISOString();
  return { path: transcriptPath, mtimeIso, lastUserMessage, lastAssistantText, digest };
}
