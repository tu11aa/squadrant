import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractTranscriptTail, DIGEST_BYTE_CAP } from "../handoff-transcript.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

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

// #753: last-user/last-assistant-only was throwing away everything a gap
// session actually did. `digest` reconstructs a bounded summary instead —
// lastUserMessage/lastAssistantText stay for compatibility.
describe("extractTranscriptTail — digest (#753)", () => {
  const fixture = path.join(FIXTURES_DIR, "gap-session-transcript.jsonl");

  it("lists ordered user prompts", () => {
    const result = extractTranscriptTail(fixture);

    expect(result?.digest.userPrompts).toEqual([
      "Fix the null-check bug in the login flow, see auth.ts",
      "Great, now open a PR for it — this closes issue #753",
    ]);
  });

  it("lists assistant final text per turn, not just the last one", () => {
    const result = extractTranscriptTail(fixture);

    expect(result?.digest.assistantTexts).toEqual([
      "Fixed the null check in auth.ts and confirmed with tests. Ready for review.",
      "Opened PR #760 closing issue #753, commit abc1234 on develop.",
    ]);
  });

  it("counts tool calls by name", () => {
    const result = extractTranscriptTail(fixture);

    expect(result?.digest.toolCalls).toEqual({ Read: 1, Edit: 1, Bash: 2 });
  });

  it("collects files touched from tool inputs", () => {
    const result = extractTranscriptTail(fixture);

    expect(result?.digest.filesTouched).toEqual(["/repo/src/auth.ts"]);
  });

  it("finds PR/issue and commit refs mentioned in prompts and replies", () => {
    const result = extractTranscriptTail(fixture);

    expect(result?.digest.refs).toEqual(expect.arrayContaining(["#753", "#760", "abc1234"]));
  });

  it("still fills lastUserMessage/lastAssistantText for compatibility", () => {
    const result = extractTranscriptTail(fixture);

    expect(result?.lastUserMessage).toBe("Great, now open a PR for it — this closes issue #753");
    expect(result?.lastAssistantText).toBe("Opened PR #760 closing issue #753, commit abc1234 on develop.");
  });

  it("marks truncated: false when a transcript fits comfortably under the cap", () => {
    const result = extractTranscriptTail(fixture);

    expect(result?.digest.truncated).toBe(false);
  });

  it("caps the digest to ~8KB, dropping oldest entries and setting truncated: true", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-transcript-"));
    try {
      const file = path.join(dir, "big.jsonl");
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        lines.push(userLine(`prompt number ${i} `.repeat(20)));
        lines.push(assistantLine(`reply number ${i} `.repeat(20)));
      }
      fs.writeFileSync(file, lines.join("\n") + "\n");

      const result = extractTranscriptTail(file);

      expect(result?.digest.truncated).toBe(true);
      const size = Buffer.byteLength(JSON.stringify(result?.digest), "utf-8");
      expect(size).toBeLessThanOrEqual(DIGEST_BYTE_CAP);
      // most recent turns are kept over the oldest ones
      expect(result?.digest.userPrompts.at(-1)).toContain("prompt number 199");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
