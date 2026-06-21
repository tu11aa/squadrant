// src/control/__tests__/squadrantd-list.test.ts
// Integration test for kind:"list" round-trip (Bug #2 regression guard).
// The "crew tasks" command was timing out because no existing test covered
// the list path — this ensures the round-trip stays working.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSquadrantd } from "../squadrantd.js";
import { sendRequest } from "@squadrant/core";

describe("kind:list round-trip (#2 crew tasks)", () => {
  let stop: (() => Promise<void>) | undefined;
  let dir: string;

  afterEach(async () => {
    if (stop) await stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] for an empty project (no ENOENT, no timeout)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-list-"));
    const sock = join(dir, "c.sock");
    const handle = startSquadrantd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0, rotationIntervalMs: 0 });
    stop = handle.stop;

    const result = await sendRequest(sock, { kind: "list", project: "myproject" });
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(0);
  });

  it("returns seeded tasks for a project", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-list-"));
    const sock = join(dir, "c.sock");
    const handle = startSquadrantd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0, rotationIntervalMs: 0 });
    stop = handle.stop;

    const record = {
      id: "task-abc", project: "myproject", provider: "claude" as const, mode: "interactive" as const,
      state: "submitted" as const, task: "do something", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 300_000,
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
    };
    await sendRequest(sock, { kind: "seed", record });

    const result = await sendRequest(sock, { kind: "list", project: "myproject" });
    expect(Array.isArray(result)).toBe(true);
    const tasks = result as Array<{ id: string; state: string }>;
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe("task-abc");
    expect(tasks[0].state).toBe("submitted");
  });

  it("does not include tasks from other projects", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-list-"));
    const sock = join(dir, "c.sock");
    const handle = startSquadrantd({ stateRoot: join(dir, "state"), sockPath: sock, sweepMs: 0, rotationIntervalMs: 0 });
    stop = handle.stop;

    await sendRequest(sock, {
      kind: "seed",
      record: {
        id: "task-p1", project: "proj1", provider: "claude" as const, mode: "interactive" as const,
        state: "submitted" as const, task: "t", createdAt: 1, lastHeartbeat: 1,
        lastEvent: "", heartbeatBudgetMs: 300_000,
        attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
      },
    });
    await sendRequest(sock, {
      kind: "seed",
      record: {
        id: "task-p2", project: "proj2", provider: "claude" as const, mode: "interactive" as const,
        state: "submitted" as const, task: "t", createdAt: 1, lastHeartbeat: 1,
        lastEvent: "", heartbeatBudgetMs: 300_000,
        attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
      },
    });

    const result = await sendRequest(sock, { kind: "list", project: "proj1" });
    const tasks = result as Array<{ id: string }>;
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe("task-p1");
  });
});
