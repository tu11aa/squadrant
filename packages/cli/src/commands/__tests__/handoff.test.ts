import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { TaskRecord } from "@squadrant/shared";

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

describe("runHandoffFacts", () => {
  let tmp: string;
  let repoDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squadrant-handoff-cmd-"));
    repoDir = path.join(tmp, "repo");
    fs.mkdirSync(repoDir);
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoDir });
    vi.resetAllMocks();
    loadConfig.mockReturnValue({
      projects: {
        squadrant: { path: repoDir, captainName: "squadrant-captain", spokeVault: "/tmp/vault", host: "local" },
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

  it("wires all sources together into a facts object, stamped with the injected `now` — no authored fields", async () => {
    const out = (await runHandoffFacts("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      claudeProjectsDir: path.join(tmp, "no-such-transcripts"),
      now: "2026-08-03T00:00:00.000Z",
      fetchTasks: async () => [makeTask({ name: "crew-1", state: "blocked", question: "which way?" })],
    })) as unknown as Record<string, unknown>;

    expect(out.meta).toMatchObject({ generatedAt: "2026-08-03T00:00:00.000Z" });
    expect((out.liveRepo as { liveCrews: unknown[] }).liveCrews).toEqual([
      { name: "crew-1", state: "blocked", task: "do the thing", question: "which way?" },
    ]);
    // The old authored shape must not leak back in.
    expect(out).not.toHaveProperty("session");
    expect(out).not.toHaveProperty("reconstructed");
  });

  it("degrades gracefully (no crash) when fetchTasks throws, e.g. daemon unreachable", async () => {
    const out = await runHandoffFacts("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      claudeProjectsDir: path.join(tmp, "no-such-transcripts"),
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
      claudeProjectsDir: path.join(tmp, "no-such-transcripts"),
      now: "2026-08-03T00:00:00.000Z",
      fetchTasks: async () => [],
    });

    const after = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf-8" });
    expect(after).toBe(before);
  });
});
