// Tests for the Claude session-registry reader (#667 slice 1).
// Pure functions only — no real filesystem, no real ~/.claude/sessions.
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseRegistryDir, toLifecycleSnapshot } from "../registry.js";
import type { ClaudeRegistryEntry } from "../registry.js";

import fs from "node:fs";

const NOW = 1_786_807_700_000;

function entry(over: Partial<ClaudeRegistryEntry> = {}): ClaudeRegistryEntry {
  return { pid: 51712, sessionId: "sess-1", cwd: "/repo", entrypoint: "cli",
           status: "idle", statusUpdatedAt: NOW - 1000, ...over };
}

describe("parseRegistryDir", () => {
  it("keeps only <pid>.json files", () => {
    const files = ["51712.json", "51712.abc.key", "notes.txt", "12242.json"];
    const read = (n: string) => JSON.stringify({ pid: parseInt(n, 10), entrypoint: "cli" });
    expect(parseRegistryDir(files, read).map((e) => e.pid)).toEqual([51712, 12242]);
  });

  it("skips a torn write instead of throwing", () => {
    const read = (n: string) => (n === "1.json" ? "{ not json" : JSON.stringify({ pid: 2 }));
    expect(parseRegistryDir(["1.json", "2.json"], read).map((e) => e.pid)).toEqual([2]);
  });

  it("skips a file that disappears mid-read", () => {
    const read = (n: string) => {
      if (n === "1.json") throw new Error("ENOENT");
      return JSON.stringify({ pid: 2 });
    };
    expect(parseRegistryDir(["1.json", "2.json"], read).map((e) => e.pid)).toEqual([2]);
  });

  it("takes pid from the filename, not the body (body may be stale)", () => {
    const read = () => JSON.stringify({ pid: 999, entrypoint: "cli" });
    expect(parseRegistryDir(["51712.json"], read)[0].pid).toBe(51712);
  });
});

describe("toLifecycleSnapshot — status mapping", () => {
  it("busy maps to running", () => {
    expect(toLifecycleSnapshot(entry({ status: "busy" }), "t1", true, NOW).state).toBe("running");
  });

  it("shell maps to running", () => {
    expect(toLifecycleSnapshot(entry({ status: "shell" }), "t1", true, NOW).state).toBe("running");
  });

  it("idle maps to idle", () => {
    expect(toLifecycleSnapshot(entry({ status: "idle" }), "t1", true, NOW).state).toBe("idle");
  });

  it("waiting maps to needsInput and carries waitingFor as the reason", () => {
    const snap = toLifecycleSnapshot(
      entry({ status: "waiting", waitingFor: "permission prompt" }), "t1", true, NOW);
    expect(snap.state).toBe("needsInput");
    expect(snap.detail?.reason).toBe("permission prompt");
  });

  it("is origin 'agent', never 'scan' — a scan signal may not assert needsInput", () => {
    // The registry is the agent's OWN self-report; squadrant merely polls to read
    // it. origin describes trust in the SOURCE, not the transport. Marking this
    // "scan" would make reduceLifecycle silently discard every needsInput.
    expect(toLifecycleSnapshot(entry({ status: "waiting" }), "t1", true, NOW).origin).toBe("agent");
  });
});

describe("toLifecycleSnapshot — the three mandatory guards", () => {
  it("guard 3: a missing status field maps to unknown, NOT idle", () => {
    // sdk-cli sessions carry no status. Mapping absence to idle would announce
    // "ready for work" about a session squadrant does not understand.
    const snap = toLifecycleSnapshot(
      entry({ entrypoint: "sdk-cli", status: undefined, statusUpdatedAt: undefined }),
      "t1", true, NOW);
    expect(snap.state).toBe("unknown");
  });

  it("guard 3: an unrecognised status value maps to unknown", () => {
    expect(toLifecycleSnapshot(
      entry({ status: "hibernating" as never }), "t1", true, NOW).state).toBe("unknown");
  });

  it("guard 1: a dead pid reports alive:false and state unknown, not its frozen status", () => {
    // A crashed session's last status is frozen and looks fresh forever. This is
    // the exact mechanism behind today's phantom CREW STALLED.
    const snap = toLifecycleSnapshot(entry({ status: "busy" }), "t1", false, NOW);
    expect(snap.alive).toBe(false);
    expect(snap.state).toBe("unknown");
  });

  it("guard 2: `at` comes from statusUpdatedAt so a stale read cannot overwrite a newer state", () => {
    const snap = toLifecycleSnapshot(entry({ statusUpdatedAt: 12345 }), "t1", true, NOW);
    expect(snap.at).toBe(12345);
  });

  it("guard 2: falls back to now when statusUpdatedAt is absent", () => {
    expect(toLifecycleSnapshot(
      entry({ statusUpdatedAt: undefined, status: undefined }), "t1", true, NOW).at).toBe(NOW);
  });

  it("carries taskId and pid through", () => {
    const snap = toLifecycleSnapshot(entry(), "task-abc", true, NOW);
    expect(snap.taskId).toBe("task-abc");
    expect(snap.pid).toBe(51712);
  });
});

import { readClaudeStatusByCwd } from "../registry.js";

describe("readClaudeStatusByCwd (#667 slice 4)", () => {
  it("returns undefined when the directory cannot be read", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("ENOENT"); });
    expect(readClaudeStatusByCwd("/nonexistent")).toBeUndefined();
  });

  it("returns the status of the session matching the cwd", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["1.json", "2.json"] as any);
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((path: any, options: any) => {
      
      if (path.toString().endsWith("1.json")) return JSON.stringify({ cwd: "/repo-a", status: "idle", statusUpdatedAt: 1 });
      if (path.toString().endsWith("2.json")) return JSON.stringify({ cwd: "/repo-b", status: "busy", statusUpdatedAt: 2 });
      return originalRead(path, options);
    });
    expect(readClaudeStatusByCwd("/repo-b")).toEqual({ status: "busy", statusUpdatedAt: 2 });
  });

  it("returns undefined for an unknown cwd", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["1.json"] as any);
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((path: any, options: any) => {
      if (path.toString().endsWith("1.json")) return JSON.stringify({ cwd: "/repo-a", status: "idle" });
      return originalRead(path, options);
    });
    expect(readClaudeStatusByCwd("/repo-b")).toBeUndefined();
  });
});

import { readClaudeStatus } from "../registry.js";

describe("readClaudeStatus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolver returns the entry whose socket path matches", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["1.json", "2.json"] as any);
    vi.spyOn(fs, "readFileSync").mockImplementation((path: any) => {
      if (path.toString().endsWith("1.json")) return JSON.stringify({ messagingSocketPath: "/tmp/sock1", status: "idle" });
      if (path.toString().endsWith("2.json")) return JSON.stringify({ messagingSocketPath: "/tmp/sock2", status: "busy" });
      throw new Error("ENOENT");
    });
    expect(readClaudeStatus({ id: "t1", messagingSocketPath: "/tmp/sock2" } as any)).toEqual({ status: "busy", statusUpdatedAt: undefined });
  });

  it("returns undefined for an unknown socket path", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["1.json"] as any);
    vi.spyOn(fs, "readFileSync").mockImplementation((path: any) => {
      if (path.toString().endsWith("1.json")) return JSON.stringify({ messagingSocketPath: "/tmp/sock1", status: "idle" });
      throw new Error("ENOENT");
    });
    expect(readClaudeStatus({ id: "t1", messagingSocketPath: "/tmp/sock-unknown" } as any)).toBeUndefined();
  });

  it("malformed/vanished registry files are skipped, not thrown on", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["1.json", "2.json", "3.json"] as any);
    vi.spyOn(fs, "readFileSync").mockImplementation((path: any) => {
      if (path.toString().endsWith("1.json")) throw new Error("ENOENT"); // vanished
      if (path.toString().endsWith("2.json")) return "{ not json"; // malformed
      if (path.toString().endsWith("3.json")) return JSON.stringify({ messagingSocketPath: "/tmp/sock3", status: "shell" });
      throw new Error("ENOENT");
    });
    expect(readClaudeStatus({ id: "t1", messagingSocketPath: "/tmp/sock3" } as any)).toEqual({ status: "shell", statusUpdatedAt: undefined });
  });

  it("statusFor falls back to pid/sessionId when messagingSocketPath is absent", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["1.json"] as any);
    vi.spyOn(fs, "readFileSync").mockImplementation((path: any) => {
      if (path.toString().endsWith("1.json")) return JSON.stringify({ pid: 1, sessionId: "sess-1", status: "waiting" });
      throw new Error("ENOENT");
    });
    expect(readClaudeStatus({ id: "t1", pid: 1, sessionId: "sess-1" } as any)).toEqual({ status: "waiting", statusUpdatedAt: undefined });
  });
});
