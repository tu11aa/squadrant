// packages/core/src/daemon/__tests__/reap-orphaned-crews.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapOrphanedCrews } from "../delivery-loop.js";
import { createStore } from "../../store.js";
import type { TaskRecord } from "@squadrant/shared";

function rec(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id, project: "p", provider: "claude", mode: "interactive",
    state: "working", task: "t", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000,
    attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
    ...overrides,
  };
}

// #595: a captain that LOOKS stopped/gone (the trigger for this reap) is not
// proof the crew's own pane is gone too — #697 showed captain liveness can
// false-positive. Before this fix, reapOrphanedCrews cancelled every
// non-terminal interactive crew unconditionally the instant the captain read
// as dead, with no check of the crew's own surface.
describe("reapOrphanedCrews (#595)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cp-reap-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("does NOT reap an interactive crew whose surface is still alive", async () => {
    const store = createStore(dir);
    store.put(rec("t1"));
    const reaped = await reapOrphanedCrews(store, "p", async () => "alive");
    expect(reaped).toBe(0);
    expect(store.get("p", "t1")?.state).toBe("working");
  });

  it("does NOT reap when surface liveness is unknown (fail-safe, same as every other surface-gated reap)", async () => {
    const store = createStore(dir);
    store.put(rec("t2"));
    const reaped = await reapOrphanedCrews(store, "p", async () => "unknown");
    expect(reaped).toBe(0);
    expect(store.get("p", "t2")?.state).toBe("working");
  });

  it("reaps an interactive crew whose surface is confirmed gone", async () => {
    const store = createStore(dir);
    store.put(rec("t3"));
    const reaped = await reapOrphanedCrews(store, "p", async () => "gone");
    expect(reaped).toBe(1);
    const r = store.get("p", "t3");
    expect(r?.state).toBe("cancelled");
    expect(r?.lastEvent).toBe("captain-stopped");
  });

  it("never probes or reaps headless crews (they have no cmux surface)", async () => {
    const store = createStore(dir);
    store.put(rec("t4", { mode: "headless" }));
    let probed = false;
    const reaped = await reapOrphanedCrews(store, "p", async () => { probed = true; return "gone"; });
    expect(reaped).toBe(0);
    expect(probed).toBe(false);
    expect(store.get("p", "t4")?.state).toBe("working");
  });

  it("skips already-terminal records without probing", async () => {
    const store = createStore(dir);
    store.put(rec("t5", { state: "done" }));
    let probed = false;
    const reaped = await reapOrphanedCrews(store, "p", async () => { probed = true; return "gone"; });
    expect(reaped).toBe(0);
    expect(probed).toBe(false);
  });
});
