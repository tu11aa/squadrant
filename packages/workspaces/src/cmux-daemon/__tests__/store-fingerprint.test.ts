import { describe, it, expect } from "vitest";
import { parseStoreRecords, readLivenessSnapshot } from "../store-fingerprint.js";

const projects = { squadrant: { path: "/Users/me/squadrant" } };

const file = JSON.stringify({
  sessions: {
    a: { sessionId: "a", pid: 41030, cwd: "/Users/me/squadrant", isRestorable: true,
         launchCommand: { arguments: ["claude","--append-system-prompt-file","/x/templates/captain.claude.md"] } },
    b: { sessionId: "b", pid: 74497, cwd: "/Users/me/squadrant", isRestorable: true,
         launchCommand: { arguments: ["claude","--append-system-prompt-file","/x/templates/side.research.claude.md"] } },
    // cwd matches the known project so this record isn't dropped by the
    // project filter — pid:null (hibernated) is the thing under test here.
    c: { sessionId: "c", pid: null, cwd: "/Users/me/squadrant",
         launchCommand: { arguments: ["claude"] } },
  },
});

describe("parseStoreRecords", () => {
  it("identifies the captain by template, not cwd (captain+side share cwd)", () => {
    const recs = parseStoreRecords(file, projects);
    const cap = recs.find((r) => r.role === "captain");
    expect(cap?.project).toBe("squadrant");
    expect(cap?.pid).toBe(41030);
    expect(cap?.present).toBe(true);
  });
  it("classifies a sibling side-session as role 'command'/'unknown', not captain", () => {
    const recs = parseStoreRecords(file, projects);
    expect(recs.filter((r) => r.role === "captain")).toHaveLength(1);
  });
  it("handles pid:null (hibernated) without dropping the record", () => {
    const recs = parseStoreRecords(file, projects);
    expect(recs.some((r) => r.pid === null)).toBe(true);
  });
  it("throws on invalid JSON (distinguishes 'unreadable' from 'valid + empty')", () => {
    expect(() => parseStoreRecords("{not json", projects)).toThrow();
  });
});

describe("readLivenessSnapshot — distinguishes a bad read from a genuinely-empty one", () => {
  it("all files corrupt/unreadable → throws (must NOT be treated as zero captains)", () => {
    const readFile = () => { throw new Error("mid-write / locked"); };
    expect(() => readLivenessSnapshot(["a-hook-sessions.json", "b-hook-sessions.json"], readFile, projects))
      .toThrow();
  });
  it("one good file among corrupt ones → returns records from the good file", () => {
    const readFile = (f: string) => {
      if (f === "good-hook-sessions.json") return file;
      throw new Error("corrupt");
    };
    const recs = readLivenessSnapshot(["bad-hook-sessions.json", "good-hook-sessions.json"], readFile, projects);
    expect(recs.some((r) => r.role === "captain")).toBe(true);
  });
  it("genuinely zero files (readdir ok, none present) → returns [] (not a throw)", () => {
    const readFile = () => { throw new Error("should never be called"); };
    expect(readLivenessSnapshot([], readFile, projects)).toEqual([]);
  });
});
