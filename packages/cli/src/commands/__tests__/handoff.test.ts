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

import { runHandoffReconstruct } from "../handoff.js";

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

describe("runHandoffReconstruct", () => {
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
    await expect(runHandoffReconstruct("nope")).rejects.toThrow(/not found/i);
  });

  it("wires all three tiers together into a reconstructed handoff, stamped with the injected `now`", async () => {
    const out = await runHandoffReconstruct("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      claudeProjectsDir: path.join(tmp, "no-such-transcripts"),
      now: "2026-08-03T00:00:00.000Z",
      fetchTasks: async () => [makeTask({ name: "crew-1", state: "blocked", question: "which way?" })],
    });

    expect(out.reconstructed).toBe(true);
    expect(out.written_at).toBe("2026-08-03T00:00:00.000Z");
    expect(out.session.blockedItems).toEqual(["crew-1: which way?"]);
  });

  it("degrades gracefully (no crash) when fetchTasks throws, e.g. daemon unreachable", async () => {
    const out = await runHandoffReconstruct("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      claudeProjectsDir: path.join(tmp, "no-such-transcripts"),
      now: "2026-08-03T00:00:00.000Z",
      fetchTasks: async () => {
        throw new Error("daemon unreachable");
      },
    });

    expect(out.session.activeTasks).toBe("");
    expect(out.session.blockedItems).toEqual([]);
  });

  it("is side-effect free — the project checkout is untouched", async () => {
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf-8" });

    await runHandoffReconstruct("squadrant", {
      claudeMemDbPath: path.join(tmp, "no-such.db"),
      claudeProjectsDir: path.join(tmp, "no-such-transcripts"),
      now: "2026-08-03T00:00:00.000Z",
      fetchTasks: async () => [],
    });

    const after = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf-8" });
    expect(after).toBe(before);
  });
});
