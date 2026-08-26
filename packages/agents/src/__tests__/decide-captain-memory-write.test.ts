import { describe, it, expect } from "vitest";
import { decideCaptainMemoryWrite } from "../interactive/claude.js";

const HOME = "/Users/q3labsadmin";
const CREW_ENV = { SQUADRANT_CREW_TASK_ID: "task-1", SQUADRANT_CREW_PROJECT: "squadrant" };
const CAPTAIN_ENV = {};

describe("decideCaptainMemoryWrite (#556)", () => {
  it("denies a crew Write into the captain's memory directory", () => {
    const result = decideCaptainMemoryWrite(
      "Write",
      { file_path: `${HOME}/.claude/projects/-Users-q3labsadmin-me-squadrant/memory/MEMORY.md` },
      CREW_ENV,
      HOME,
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/#556/);
  });

  it("denies a crew Edit into a memory file other than MEMORY.md", () => {
    const result = decideCaptainMemoryWrite(
      "Edit",
      { file_path: `${HOME}/.claude/projects/-Users-q3labsadmin-me-squadrant/memory/user_role.md` },
      CREW_ENV,
      HOME,
    );
    expect(result.decision).toBe("deny");
  });

  it("denies a crew MultiEdit into the memory directory", () => {
    const result = decideCaptainMemoryWrite(
      "MultiEdit",
      { file_path: `${HOME}/.claude/projects/-Users-q3labsadmin-me-squadrant/memory/MEMORY.md`, edits: [] },
      CREW_ENV,
      HOME,
    );
    expect(result.decision).toBe("deny");
  });

  it("denies a crew NotebookEdit into the memory directory (notebook_path, not file_path)", () => {
    const result = decideCaptainMemoryWrite(
      "NotebookEdit",
      { notebook_path: `${HOME}/.claude/projects/-Users-q3labsadmin-me-squadrant/memory/notes.ipynb` },
      CREW_ENV,
      HOME,
    );
    expect(result.decision).toBe("deny");
  });

  it("denies a crew Bash command that targets a memory path in its text (best-effort match)", () => {
    const result = decideCaptainMemoryWrite(
      "Bash",
      { command: `echo "wrong conclusion" >> ${HOME}/.claude/projects/-Users-q3labsadmin-me-squadrant/memory/foo.md` },
      CREW_ENV,
      HOME,
    );
    expect(result.decision).toBe("deny");
  });

  it("allows a crew Bash command with no memory-path reference", () => {
    const result = decideCaptainMemoryWrite("Bash", { command: "npm test" }, CREW_ENV, HOME);
    expect(result.decision).toBe("allow");
  });

  it("allows a crew Write outside the memory directory", () => {
    const result = decideCaptainMemoryWrite(
      "Write",
      { file_path: `${HOME}/me/squadrant/.worktrees/foo/src/index.ts` },
      CREW_ENV,
      HOME,
    );
    expect(result.decision).toBe("allow");
  });

  it("allows non-Write/Edit tools targeting the memory directory (e.g. Read)", () => {
    const result = decideCaptainMemoryWrite(
      "Read",
      { file_path: `${HOME}/.claude/projects/-Users-q3labsadmin-me-squadrant/memory/MEMORY.md` },
      CREW_ENV,
      HOME,
    );
    expect(result.decision).toBe("allow");
  });

  it("allows a captain/command session (no SQUADRANT_CREW_TASK_ID) to write its own memory", () => {
    const result = decideCaptainMemoryWrite(
      "Write",
      { file_path: `${HOME}/.claude/projects/-Users-q3labsadmin-me-squadrant/memory/MEMORY.md` },
      CAPTAIN_ENV,
      HOME,
    );
    expect(result.decision).toBe("allow");
  });

  it("allows when tool_input is malformed or missing file_path", () => {
    expect(decideCaptainMemoryWrite("Write", {}, CREW_ENV, HOME).decision).toBe("allow");
    expect(decideCaptainMemoryWrite("Write", undefined, CREW_ENV, HOME).decision).toBe("allow");
    expect(decideCaptainMemoryWrite("Write", null, CREW_ENV, HOME).decision).toBe("allow");
  });

  it("does not false-positive on an unrelated path that merely contains 'memory'", () => {
    const result = decideCaptainMemoryWrite(
      "Write",
      { file_path: `${HOME}/me/squadrant/src/memory-cache.ts` },
      CREW_ENV,
      HOME,
    );
    expect(result.decision).toBe("allow");
  });
});
