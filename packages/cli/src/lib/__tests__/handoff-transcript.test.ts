import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readNewestTranscriptTail } from "../handoff-transcript.js";

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

describe("readNewestTranscriptTail", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-transcripts-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the directory does not exist", () => {
    expect(readNewestTranscriptTail(path.join(dir, "missing"))).toBeNull();
  });

  it("returns null when there are no .jsonl files", () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
    expect(readNewestTranscriptTail(dir)).toBeNull();
  });

  it("picks the newest .jsonl file by mtime, not by name", () => {
    const older = path.join(dir, "aaa-newer-name-but-older-mtime.jsonl");
    const newer = path.join(dir, "zzz.jsonl");
    fs.writeFileSync(older, userLine("from older file"));
    fs.writeFileSync(newer, userLine("from newer file"));
    const now = Date.now();
    fs.utimesSync(older, new Date(now - 10_000), new Date(now - 10_000));
    fs.utimesSync(newer, new Date(now), new Date(now));

    const result = readNewestTranscriptTail(dir);

    expect(result?.path).toBe(newer);
    expect(result?.lastUserMessage).toBe("from newer file");
  });

  it("extracts the last user message and last assistant text", () => {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      [userLine("first question"), assistantLine("first answer"), userLine("second question"), assistantLine("second answer")].join("\n") + "\n",
    );

    const result = readNewestTranscriptTail(dir);

    expect(result?.lastUserMessage).toBe("second question");
    expect(result?.lastAssistantText).toBe("second answer");
  });

  it("ignores malformed lines instead of crashing", () => {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, ["not json at all", userLine("a real message")].join("\n") + "\n");

    const result = readNewestTranscriptTail(dir);

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
    const result = readNewestTranscriptTail(dir, 200);

    expect(result?.lastUserMessage).toBe("NEW");
  });

  it("reports the file's mtime as an ISO string", () => {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, userLine("hi"));
    const mtime = new Date("2026-08-01T12:00:00.000Z");
    fs.utimesSync(file, mtime, mtime);

    const result = readNewestTranscriptTail(dir);

    expect(result?.mtimeIso).toBe(mtime.toISOString());
  });
});
