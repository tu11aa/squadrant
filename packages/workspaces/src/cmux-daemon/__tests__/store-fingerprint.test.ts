import { describe, it, expect } from "vitest";
import { parseStoreRecords, readLivenessSnapshot, readArgvFromPid } from "../store-fingerprint.js";

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

describe("parseStoreRecords — #699 OS argv fallback for truncated cmux store argv", () => {
  const truncatedCaptainFile = JSON.stringify({
    sessions: {
      a: {
        sessionId: "a", pid: 12236, cwd: "/Users/me/squadrant", isRestorable: true,
        // Truncated by cmux (argc=4): missing --append-system-prompt-file entirely.
        launchCommand: { arguments: ["claude", "--permission-mode", "auto", "--messaging-socket-path"] },
      },
    },
  });
  const fullOsArgv = [
    "claude", "--permission-mode", "auto", "--messaging-socket-path", "/tmp/x.sock",
    "--append-system-prompt-file", "/x/templates/captain.claude.md",
  ];

  it("recovers role from OS argv when stored argv is truncated and pid is alive", () => {
    const recs = parseStoreRecords(truncatedCaptainFile, projects, {
      isPidAlive: () => true,
      readArgv: () => fullOsArgv,
    });
    expect(recs[0].role).toBe("captain");
  });

  it("does not call readArgv when the pid is not alive (never invents a role for a dead pid)", () => {
    const readArgv = () => { throw new Error("must not be called"); };
    const recs = parseStoreRecords(truncatedCaptainFile, projects, {
      isPidAlive: () => false,
      readArgv,
    });
    expect(recs[0].role).toBe("unknown");
  });

  it("does not call readArgv for a session whose stored argv already classifies cleanly (no regression)", () => {
    const calledPids: number[] = [];
    const readArgv = (pid: number) => { calledPids.push(pid); return undefined; };
    const recs = parseStoreRecords(file, projects, { isPidAlive: () => true, readArgv });
    // session "a" (pid 41030) classifies as captain from stored argv alone — no OS lookup needed.
    expect(calledPids).not.toContain(41030);
    expect(recs.find((r) => r.role === "captain")?.pid).toBe(41030);
  });

  it("stays 'unknown' when the OS argv read also fails to classify (e.g. a genuine side-session)", () => {
    const recs = parseStoreRecords(truncatedCaptainFile, projects, {
      isPidAlive: () => true,
      readArgv: () => ["claude", "--permission-mode", "auto"],
    });
    expect(recs[0].role).toBe("unknown");
  });
});

describe("readLivenessSnapshot — threads the argv-fallback deps through to parseStoreRecords", () => {
  it("passes isPidAlive/readArgv down so a truncated-argv captain is recovered", () => {
    const truncated = JSON.stringify({
      sessions: {
        a: {
          sessionId: "a", pid: 12236, cwd: "/Users/me/squadrant", isRestorable: true,
          launchCommand: { arguments: ["claude", "--messaging-socket-path"] },
        },
      },
    });
    const recs = readLivenessSnapshot(["a-hook-sessions.json"], () => truncated, projects, {
      isPidAlive: () => true,
      readArgv: () => ["claude", "--append-system-prompt-file", "/x/templates/captain.claude.md"],
    });
    expect(recs[0].role).toBe("captain");
  });
});

describe("readArgvFromPid — real OS process-table reader (#699)", () => {
  it("returns undefined for a dead/nonexistent pid instead of throwing (ps failure handled gracefully)", () => {
    expect(readArgvFromPid(999999)).toBeUndefined();
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
