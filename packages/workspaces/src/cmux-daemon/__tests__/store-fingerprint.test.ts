import { describe, it, expect } from "vitest";
import { parseStoreRecords } from "../store-fingerprint.js";

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
});
