import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseTranscriptLine, latestContextFromLines, readClaudeContext, clearContextMeterCache,
  crewTranscriptPath, meterTask, formatContext, escapeClaudeProjectPath,
} from "../context-meter.js";

const asst = (id: string, input: number, read: number, write: number, model = "claude-opus-4") =>
  JSON.stringify({
    type: "assistant", timestamp: "2026-10-21T00:00:00Z",
    message: { id, role: "assistant", model, usage: { input_tokens: input, output_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: write } },
  });
const user = JSON.stringify({ type: "user", timestamp: "2026-10-21T00:00:00Z", message: { role: "user", content: "hi" } });

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-meter-")); clearContextMeterCache(); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("parseTranscriptLine", () => {
  it("extracts usage, message id and model from an assistant line", () => {
    const r = parseTranscriptLine(asst("m1", 3, 100, 20));
    expect(r.usage).toEqual({ input: 3, output: 5, cacheRead: 100, cacheWrite: 20 });
    expect(r.messageId).toBe("m1");
    expect(r.model).toBe("claude-opus-4");
  });
  it("gives no usage for user, blank or corrupt lines", () => {
    expect(parseTranscriptLine(user).usage).toBeNull();
    expect(parseTranscriptLine("").usage).toBeNull();
    expect(parseTranscriptLine("{not json").usage).toBeNull();
  });
});

describe("latestContextFromLines", () => {
  it("is input + cache_read + cache_creation of the latest assistant call", () => {
    expect(latestContextFromLines([asst("a", 1, 10, 1), user, asst("b", 2, 200, 8)])?.tokens).toBe(210);
  });
  it("dedupes lines that share a message id (mirror/streamed block lines)", () => {
    // Same id repeated: the newest line wins, older duplicates never shadow an earlier real call.
    const r = latestContextFromLines([asst("a", 1, 10, 0), asst("b", 2, 50, 0), asst("b", 2, 50, 0)]);
    expect(r?.tokens).toBe(52);
  });
  it("skips all-zero (synthetic) usage and returns null when nothing is usable", () => {
    expect(latestContextFromLines([asst("a", 1, 10, 0), asst("s", 0, 0, 0)])?.tokens).toBe(11);
    expect(latestContextFromLines([user])).toBeNull();
  });
});

describe("readClaudeContext", () => {
  it("returns unknown for a missing file or a transcript without usage", () => {
    expect(readClaudeContext(path.join(dir, "nope.jsonl"))).toBe("unknown");
    const f = path.join(dir, "t.jsonl");
    fs.writeFileSync(f, user + "\n");
    expect(readClaudeContext(f)).toBe("unknown");
  });

  it("reads only the tail of a large transcript and gets the latest call", () => {
    const f = path.join(dir, "big.jsonl");
    const filler = asst("old", 1, 111, 0) + "\n";
    // ~3 MB of old calls, then the real latest one.
    fs.writeFileSync(f, filler.repeat(Math.ceil((3 * 1024 * 1024) / filler.length)) + asst("new", 4, 182_000, 6) + "\n");
    const size = fs.statSync(f).size;
    const spy = vi.spyOn(fs, "readSync");
    const r = readClaudeContext(f);
    expect(r).not.toBe("unknown");
    expect((r as { tokens: number }).tokens).toBe(182_010);
    const bytesRead = spy.mock.calls.reduce((n, c) => n + ((c as unknown[])[3] as number), 0);
    expect(bytesRead).toBeLessThan(size / 4);
  });

  it("grows the tail window when the last calls are huge non-usage lines", () => {
    const f = path.join(dir, "gap.jsonl");
    const huge = JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(400 * 1024) } });
    fs.writeFileSync(f, asst("a", 1, 5000, 0) + "\n" + huge + "\n");
    expect((readClaudeContext(f) as { tokens: number }).tokens).toBe(5001);
  });

  it("caches by mtime/size and re-reads after a write", () => {
    const f = path.join(dir, "c.jsonl");
    fs.writeFileSync(f, asst("a", 1, 100, 0) + "\n");
    const spy = vi.spyOn(fs, "openSync");
    expect((readClaudeContext(f) as { tokens: number }).tokens).toBe(101);
    readClaudeContext(f);
    expect(spy).toHaveBeenCalledTimes(1);
    fs.appendFileSync(f, asst("b", 1, 900, 0) + "\n");
    expect((readClaudeContext(f) as { tokens: number }).tokens).toBe(901);
  });

  it("reports a window only when the model name states it", () => {
    const f = path.join(dir, "w.jsonl");
    fs.writeFileSync(f, asst("a", 1, 249_999, 0, "claude-opus-4[1m]") + "\n");
    expect(readClaudeContext(f)).toMatchObject({ tokens: 250_000, windowTokens: 1_000_000, pct: 25 });
    const g = path.join(dir, "n.jsonl");
    fs.writeFileSync(g, asst("a", 1, 99, 0) + "\n");
    expect(readClaudeContext(g)).not.toHaveProperty("windowTokens");
  });
});

describe("crew transcript lookup", () => {
  const cwd = "/work/tree/crew-a";
  const proj = () => path.join(dir, escapeClaudeProjectPath(cwd));

  it("uses the session id when the record has one", () => {
    fs.mkdirSync(proj(), { recursive: true });
    fs.writeFileSync(path.join(proj(), "S1.jsonl"), asst("a", 1, 1000, 0) + "\n");
    expect(meterTask({ provider: "claude", cwd, sessionId: "S1" }, dir)).toMatchObject({ tokens: 1001 });
    expect(crewTranscriptPath({ provider: "claude", cwd, sessionId: "missing" }, dir)).toBeNull();
  });

  it("falls back to the newest transcript written since the task was created", () => {
    fs.mkdirSync(proj(), { recursive: true });
    const oldF = path.join(proj(), "old.jsonl");
    const newF = path.join(proj(), "new.jsonl");
    fs.writeFileSync(oldF, asst("a", 1, 10, 0) + "\n");
    fs.writeFileSync(newF, asst("b", 1, 2000, 0) + "\n");
    fs.utimesSync(oldF, new Date(1000), new Date(1000));
    expect(crewTranscriptPath({ provider: "claude", cwd, createdAt: 5000 }, dir)).toBe(newF);
  });

  it("is unknown for non-claude agents and for crews with no cwd", () => {
    expect(meterTask({ provider: "opencode", cwd, sessionId: "S" }, dir)).toBe("unknown");
    expect(meterTask({ provider: "codex", cwd }, dir)).toBe("unknown");
    expect(meterTask({ provider: "claude" }, dir)).toBe("unknown");
  });
});

describe("formatContext", () => {
  it("renders k/M and unknown", () => {
    expect(formatContext(182_400)).toBe("182k");
    expect(formatContext(1_250_000)).toBe("1.3M");
    expect(formatContext(900)).toBe("900");
    expect(formatContext("unknown")).toBe("unknown");
  });
});
