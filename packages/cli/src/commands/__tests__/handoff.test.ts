import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { TaskRecord } from "@squadrant/shared";
import { appendCaptainSession } from "../../lib/captain-session-registry.js";
import type { CaptainSessionRecord } from "../../lib/handoff-facts.js";

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", async () => {
  const actual = await vi.importActual<typeof import("@squadrant/shared")>("@squadrant/shared");
  return { ...actual, loadConfig };
});

import { runHandoffFacts } from "../handoff.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1",
    project: "squadrant",
    provider: "claude",
    mode: "interactive",
    state: "working",
    task: "do the thing",
    createdAt: 0,
    lastHeartbeat: 0,
    lastEvent: "dispatch",
    heartbeatBudgetMs: 300000,
    attempts: [],
    ...overrides,
  };
}

function sessionRecord(overrides: Partial<CaptainSessionRecord> = {}): CaptainSessionRecord {
  return {
    sessionId: "sess-1",
    project: "squadrant",
    agent: "claude",
    startedAt: "2026-08-01T00:00:00.000Z",
    cwd: "/repo",
    transcriptPath: "/repo/does-not-exist.jsonl",
    ...overrides,
  };
}

function writeArchive(vault: string, filename: string, content: unknown): void {
  const dir = path.join(vault, "handoffs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(content));
}

describe("runHandoffFacts", () => {
  let tmp: string;
  let repoDir: string;
  let vault: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-handoff-cmd-"));
    repoDir = path.join(tmp, "repo");
    vault = path.join(tmp, "vault");
    fs.mkdirSync(repoDir);
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoDir });
    vi.resetAllMocks();
    loadConfig.mockReturnValue({
      projects: {
        squadrant: { path: repoDir, captainName: "squadrant-captain", spokeVault: vault, host: "local" },
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("throws a clear error for an unregistered project", async () => {
    loadConfig.mockReturnValue({ projects: {} });
    await expect(runHandoffFacts("nope")).rejects.toThrow(/not found/i);
  });

  it("wires liveRepo/claudeMem through, stamped with the injected `now` — no authored fields", async () => {
    const out = (await runHandoffFacts("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      currentSessionId: "current",
      now: "2026-08-03T00:00:00.000Z",
      fetchTasks: async () => [makeTask({ name: "crew-1", state: "blocked", question: "which way?" })],
    })) as unknown as Record<string, unknown>;

    expect(out.meta).toMatchObject({ generatedAt: "2026-08-03T00:00:00.000Z" });
    expect((out.liveRepo as { liveCrews: unknown[] }).liveCrews).toEqual([
      { name: "crew-1", state: "blocked", task: "do the thing", question: "which way?" },
    ]);
    expect(out).not.toHaveProperty("session");
    expect(out).not.toHaveProperty("reconstructed");
  });

  it("degrades gracefully (no crash) when fetchTasks throws, e.g. daemon unreachable", async () => {
    const out = await runHandoffFacts("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      currentSessionId: "current",
      now: "2026-08-03T00:00:00.000Z",
      fetchTasks: async () => {
        throw new Error("daemon unreachable");
      },
    });

    expect(out.liveRepo.liveCrews).toEqual([]);
  });

  it("is side-effect free — the project checkout is untouched", async () => {
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf-8" });

    await runHandoffFacts("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      currentSessionId: "current",
      now: "2026-08-03T00:00:00.000Z",
      fetchTasks: async () => [],
    });

    const after = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf-8" });
    expect(after).toBe(before);
  });

  it("reads the newest archived handoff as the checkpoint, in full", async () => {
    writeArchive(vault, "2026-08-01.json", { session: { currentState: "older, superseded" } });
    writeArchive(vault, "2026-08-02.json", { session: { currentState: "the checkpoint" } });
    const archiveDir = path.join(vault, "handoffs");
    fs.utimesSync(path.join(archiveDir, "2026-08-01.json"), new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-01T00:00:00.000Z"));
    fs.utimesSync(path.join(archiveDir, "2026-08-02.json"), new Date("2026-08-02T00:00:00.000Z"), new Date("2026-08-02T00:00:00.000Z"));

    const out = await runHandoffFacts("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      currentSessionId: "current",
      now: "2026-08-03T12:00:00.000Z",
      fetchTasks: async () => [],
    });

    expect(out.checkpoint?.filename).toBe("2026-08-02.json");
    expect(out.meta.checkpointFilename).toBe("2026-08-02.json");
  });

  it("only reads transcripts for sessions AFTER the checkpoint (the gap) — not sessions the checkpoint already covers", async () => {
    const beforeTranscript = path.join(tmp, "before.jsonl");
    const afterTranscript = path.join(tmp, "after.jsonl");
    fs.writeFileSync(beforeTranscript, JSON.stringify({ type: "user", message: { role: "user", content: "covered by checkpoint" } }));
    fs.writeFileSync(afterTranscript, JSON.stringify({ type: "user", message: { role: "user", content: "the actual gap" } }));

    // Checkpoint archived at 08-02T00:00 (via mtime).
    writeArchive(vault, "2026-08-02.json", { session: { currentState: "checkpoint" } });
    fs.utimesSync(
      path.join(vault, "handoffs", "2026-08-02.json"),
      new Date("2026-08-02T00:00:00.000Z"),
      new Date("2026-08-02T00:00:00.000Z"),
    );

    appendCaptainSession(vault, sessionRecord({ sessionId: "before", startedAt: "2026-08-01T00:00:00.000Z", transcriptPath: beforeTranscript }));
    appendCaptainSession(vault, sessionRecord({ sessionId: "after", startedAt: "2026-08-02T12:00:00.000Z", transcriptPath: afterTranscript }));

    const out = await runHandoffFacts("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      currentSessionId: "current",
      now: "2026-08-03T12:00:00.000Z",
      fetchTasks: async () => [],
    });

    expect(out.gapSessions.map((s) => s.session.sessionId)).toEqual(["after"]);
    expect(out.gapSessions[0].transcript?.lastUserMessage).toBe("the actual gap");
  });

  it("excludes the current session from the gap by id — not by mtime", async () => {
    appendCaptainSession(vault, sessionRecord({ sessionId: "prev", startedAt: "2026-08-02T00:00:00.000Z" }));
    appendCaptainSession(vault, sessionRecord({ sessionId: "current", startedAt: "2026-08-03T00:00:00.000Z" }));

    const out = await runHandoffFacts("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      currentSessionId: "current",
      now: "2026-08-03T12:00:00.000Z",
      fetchTasks: async () => [],
    });

    expect(out.gapSessions.map((s) => s.session.sessionId)).toEqual(["prev"]);
  });

  it("falls back to a bounded window when there is no checkpoint at all", async () => {
    appendCaptainSession(vault, sessionRecord({ sessionId: "recent", startedAt: "2026-08-02T00:00:00.000Z" }));

    const out = await runHandoffFacts("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      currentSessionId: "current",
      now: "2026-08-03T12:00:00.000Z",
      fetchTasks: async () => [],
    });

    expect(out.checkpoint).toBeNull();
    expect(out.meta.usedFallbackWindow).toBe(true);
    expect(out.gapSessions.map((s) => s.session.sessionId)).toEqual(["recent"]);
  });

  it("degrades honestly via meta.registryNote when CLAUDE_CODE_SESSION_ID is unavailable — never guesses", async () => {
    appendCaptainSession(vault, sessionRecord({ sessionId: "prev" }));

    const out = await runHandoffFacts("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      currentSessionId: null,
      now: "2026-08-03T12:00:00.000Z",
      fetchTasks: async () => [],
    });

    expect(out.gapSessions).toEqual([]);
    expect(out.meta.registryNote).toContain("session id unknown");
  });

  it("notes honestly when no session registry exists yet", async () => {
    const out = await runHandoffFacts("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      currentSessionId: "current",
      now: "2026-08-03T12:00:00.000Z",
      fetchTasks: async () => [],
    });

    expect(out.meta.registryNote).toContain("no session registry");
  });
});
