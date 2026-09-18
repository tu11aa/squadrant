import { describe, it, expect } from "vitest";
import { resolveWhoami, projectForCwd, type WhoamiDeps } from "../whoami.js";

function deps(over: Partial<WhoamiDeps> = {}): WhoamiDeps {
  return {
    env: {},
    cwd: "/Users/x/me/squadrant",
    projects: { squadrant: "/Users/x/me/squadrant" },
    readCaptain: () => null,
    readTask: () => null,
    readClaudeBySocket: () => undefined,
    ...over,
  };
}

describe("projectForCwd", () => {
  it("matches an exact project path", () => {
    expect(projectForCwd("/a/b", { p: "/a/b" })).toBe("p");
  });

  it("matches a descendant path", () => {
    expect(projectForCwd("/a/b/c/d", { p: "/a/b" })).toBe("p");
  });

  it("prefers the longest matching path", () => {
    expect(projectForCwd("/a/b/c", { outer: "/a", inner: "/a/b" })).toBe("inner");
  });

  it("does not match a sibling with a shared prefix", () => {
    expect(projectForCwd("/a/bc", { p: "/a/b" })).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(projectForCwd("/elsewhere", { p: "/a/b" })).toBeNull();
  });

  it("tolerates a trailing slash on the project path", () => {
    expect(projectForCwd("/a/b/c", { p: "/a/b/" })).toBe("p");
  });
});

describe("resolveWhoami — claude", () => {
  it("self-identifies from $CLAUDE_CODE_MESSAGING_SOCKET (trap 6)", () => {
    const r = resolveWhoami(
      deps({
        env: { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/20523.sock", SQUADRANT_ROLE: "captain" },
        readClaudeBySocket: (s) =>
          s === "/tmp/cc-socks/20523.sock" ? { sessionId: "sess-1" } : undefined,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.record).toMatchObject({
      project: "squadrant",
      role: "captain",
      agent: "claude",
      sessionId: "sess-1",
      address: "/tmp/cc-socks/20523.sock",
      source: "claude-registry",
    });
  });

  it("reports identity with a null sessionId when the registry has no entry yet", () => {
    const r = resolveWhoami(
      deps({
        env: { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock" },
        readClaudeBySocket: () => undefined,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.record.sessionId).toBeNull();
    expect(r.record.note).toMatch(/registry/i);
  });
});

describe("resolveWhoami — opencode captain", () => {
  it("resolves the calling captain from the captain record", () => {
    const r = resolveWhoami(
      deps({
        env: { SQUADRANT_ROLE: "captain" },
        readCaptain: (p) =>
          p === "squadrant"
            ? { agent: "opencode", port: 49526, sessionId: "ses_abc", directory: "/Users/x/me/squadrant" }
            : null,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.record).toMatchObject({
      project: "squadrant",
      role: "captain",
      agent: "opencode",
      sessionId: "ses_abc",
      address: "http://127.0.0.1:49526",
      source: "captain-record",
    });
  });

  it("returns sessionId null + a note when the record is not resolved yet (cold start)", () => {
    const r = resolveWhoami(
      deps({
        env: { SQUADRANT_ROLE: "captain" },
        readCaptain: () => ({ agent: "opencode", port: 1234, directory: "/Users/x/me/squadrant" }),
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.record.sessionId).toBeNull();
    expect(r.record.address).toBe("http://127.0.0.1:1234");
    expect(r.record.note).toMatch(/cold start/i);
  });
});

describe("resolveWhoami — crew", () => {
  it("resolves an opencode crew from the task record", () => {
    const r = resolveWhoami(
      deps({
        env: { SQUADRANT_CREW_TASK_ID: "t1", SQUADRANT_CREW_PROJECT: "squadrant" },
        readTask: (p, id) =>
          p === "squadrant" && id === "t1"
            ? { provider: "opencode", sessionId: "ses_crew", serverPort: 51000 }
            : null,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.record).toMatchObject({
      project: "squadrant",
      role: "crew",
      agent: "opencode",
      sessionId: "ses_crew",
      address: "http://127.0.0.1:51000",
      source: "task-record",
    });
  });

  it("prefers the task record's socket for a claude-less crew", () => {
    const r = resolveWhoami(
      deps({
        env: { SQUADRANT_CREW_TASK_ID: "t2", SQUADRANT_CREW_PROJECT: "squadrant" },
        readTask: () => ({ provider: "codex", sessionId: "thread-1", messagingSocketPath: "/tmp/x.sock" }),
      }),
    );
    expect(r.record.address).toBe("/tmp/x.sock");
  });

  it("does not throw when the crew task record is missing", () => {
    const r = resolveWhoami(
      deps({ env: { SQUADRANT_CREW_TASK_ID: "gone", SQUADRANT_CREW_PROJECT: "squadrant" } }),
    );
    expect(r.ok).toBe(false);
    expect(r.record.source).toBe("none");
    expect(r.record.note).toMatch(/not found/i);
  });
});

describe("resolveWhoami — unresolved", () => {
  it("returns ok:false with a clear note when nothing identifies the caller", () => {
    const r = resolveWhoami(deps({ env: {}, cwd: "/elsewhere", projects: {} }));
    expect(r.ok).toBe(false);
    expect(r.record).toMatchObject({ role: "unknown", agent: null, sessionId: null, source: "none" });
    expect(r.record.note).toBeTruthy();
  });
});
