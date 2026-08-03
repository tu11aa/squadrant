import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractTranscriptTail } from "../handoff-transcript.js";

function userLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text }, timestamp: "2026-08-03T00:00:00.000Z" });
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: "2026-08-03T00:00:01.000Z",
  });
}

// #651: which file to read is resolved by the captain-session registry
// (ground truth, recorded at SessionStart) — never guessed by mtime, never
// content-sniffed for role. This module's only job now is extracting the
// tail of a KNOWN transcript path.
describe("extractTranscriptTail", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-transcript-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the given path does not exist", () => {
    expect(extractTranscriptTail(path.join(dir, "missing.jsonl"))).toBeNull();
  });

  it("extracts the last user message and last assistant text", () => {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      [userLine("first question"), assistantLine("first answer"), userLine("second question"), assistantLine("second answer")].join("\n") + "\n",
    );

    const result = extractTranscriptTail(file);

    expect(result?.path).toBe(file);
    expect(result?.lastUserMessage).toBe("second question");
    expect(result?.lastAssistantText).toBe("second answer");
  });

  it("ignores malformed lines instead of crashing", () => {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, ["not json at all", userLine("a real message")].join("\n") + "\n");

    const result = extractTranscriptTail(file);

    expect(result?.lastUserMessage).toBe("a real message");
  });

  it("never reads past byteCap — a hard tail-bounded cap, not a full replay", () => {
    const file = path.join(dir, "session.jsonl");
    const padding = "x".repeat(5000);
    const oldLine = userLine(`OLD-${padding}`);
    const newLine = userLine("NEW");
    fs.writeFileSync(file, oldLine + "\n" + newLine + "\n");

    // Cap smaller than the old line's length but larger than the new line —
    // the tail read must land inside oldLine (dropped as a partial first
    // line) followed by the FULL newLine, never seeing "OLD".
    const result = extractTranscriptTail(file, 200);

    expect(result?.lastUserMessage).toBe("NEW");
  });

  it("reports the file's mtime as an ISO string", () => {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, userLine("hi"));
    const mtime = new Date("2026-08-01T12:00:00.000Z");
    fs.utimesSync(file, mtime, mtime);

    const result = extractTranscriptTail(file);

    expect(result?.mtimeIso).toBe(mtime.toISOString());
  });
});
