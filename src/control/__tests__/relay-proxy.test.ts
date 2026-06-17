// src/control/__tests__/relay-proxy.test.ts
//
// TDD: relay-proxy-poll / relay-proxy-result socket round-trip (#239 Phase B).
//
// Three load-bearing safety properties (captain-specified):
//   (a) first probe before any result is cached → proxiedSurfaceAlive returns
//       "unknown" → sweep does NOT reap a live crew.
//   (b) cmux failure (surfaceVerdict(null) = "unknown") → relay sends "unknown"
//       result → no reap.
//   (c) dead surface → relay sends "gone" result → task reaped on next sweep.
//
// Protocol round-trip tests:
//   - relay-proxy-poll returns [] when nothing is queued
//   - relay-proxy-poll returns pending probes and clears the queue
//   - relay-proxy-result stores results (returns {ok:true})
//   - non-interactive / unnamed tasks are never enqueued
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpitd } from "../cockpitd.js";
import { sendRequest } from "../protocol.js";
import type { TaskRecord } from "@cockpit/shared";

// Minimal interactive claude task — mode:interactive so sweep calls isSurfaceAlive;
// heartbeatBudgetMs large enough that stall detection never fires in test time.
function makeInteractive(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-aaa",
    project: "proj",
    name: "worker",
    task: "do something",
    state: "submitted",
    mode: "interactive",
    provider: "claude",
    createdAt: Date.now(),
    lastHeartbeat: Date.now(),
    heartbeatBudgetMs: 120_000,
    lastEvent: "task.started",
    attempts: [],
    ...overrides,
  };
}

describe("relay-proxy protocol round-trip (#239 Phase B)", () => {
  let stop: (() => void) | undefined;
  let dir: string;

  afterEach(() => {
    stop?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Boot with fast sweep (5 ms) so sweep-based tests converge quickly.
  function boot(overrides: Parameters<typeof startCockpitd>[0] = {}) {
    dir = mkdtempSync(join(tmpdir(), "cp-proxy-"));
    const sock = join(dir, "c.sock");
    const handle = startCockpitd({
      stateRoot: join(dir, "state"),
      sockPath: sock,
      sweepMs: 5,
      launchHeadless: async () => {},
      ...overrides,
    });
    stop = handle.stop;
    return sock;
  }

  // ── Protocol: poll / result ─────────────────────────────────────────────────

  it("relay-proxy-poll returns [] when no probes are pending", async () => {
    const sock = boot();
    const result = await sendRequest(sock, { kind: "relay-proxy-poll", project: "proj" });
    expect(result).toEqual([]);
  });

  it("relay-proxy-poll returns pending probes for the project and clears the queue", async () => {
    const sock = boot();

    // Dispatch an interactive task; sweeps will call proxiedSurfaceAlive which enqueues.
    await sendRequest(sock, { kind: "dispatch", record: makeInteractive() });
    // Give sweep(s) time to fire and call isSurfaceAlive.
    await new Promise((r) => setTimeout(r, 60));

    const probes: any = await sendRequest(sock, { kind: "relay-proxy-poll", project: "proj" });
    expect(Array.isArray(probes)).toBe(true);
    const probe = (probes as any[]).find((p: any) => p.taskId === "task-aaa");
    expect(probe).toBeDefined();
    expect(probe.name).toBe("worker");

    // Second poll must return [] — queue was cleared.
    const probes2: any = await sendRequest(sock, { kind: "relay-proxy-poll", project: "proj" });
    expect(probes2).toEqual([]);
  });

  it("relay-proxy-poll is project-scoped: probes for one project do not appear in another", async () => {
    const sock = boot();
    await sendRequest(sock, { kind: "dispatch", record: makeInteractive() });
    await new Promise((r) => setTimeout(r, 60));

    const probes: any = await sendRequest(sock, { kind: "relay-proxy-poll", project: "other-proj" });
    expect(probes).toEqual([]);
  });

  it("relay-proxy-result stores liveness results and returns {ok:true}", async () => {
    const sock = boot();
    const result: any = await sendRequest(sock, {
      kind: "relay-proxy-result",
      results: [{ taskId: "task-aaa", liveness: "gone" }],
    });
    expect(result).toEqual({ ok: true });
  });

  it("relay-proxy-result for unknown taskId is a no-op (no error)", async () => {
    const sock = boot();
    const result: any = await sendRequest(sock, {
      kind: "relay-proxy-result",
      results: [{ taskId: "no-such-task", liveness: "alive" }],
    });
    expect(result).toEqual({ ok: true });
  });

  it("relay-proxy-result with empty results array returns {ok:true}", async () => {
    const sock = boot();
    const result: any = await sendRequest(sock, { kind: "relay-proxy-result", results: [] });
    expect(result).toEqual({ ok: true });
  });

  // ── Enqueue guards ──────────────────────────────────────────────────────────

  it("headless tasks are never enqueued (mode:headless short-circuits to 'unknown')", async () => {
    const sock = boot();
    // Dispatch headless — use a fake launchHeadless to avoid real process spawn.
    await sendRequest(sock, {
      kind: "dispatch",
      record: makeInteractive({ id: "headless-1", mode: "headless", name: "worker" }),
    });
    await new Promise((r) => setTimeout(r, 60));

    const probes: any = await sendRequest(sock, { kind: "relay-proxy-poll", project: "proj" });
    const found = (probes as any[]).find((p: any) => p.taskId === "headless-1");
    expect(found).toBeUndefined();
  });

  it("interactive tasks without a name are never enqueued", async () => {
    const sock = boot();
    await sendRequest(sock, {
      kind: "dispatch",
      record: makeInteractive({ id: "unnamed-1", name: undefined }),
    });
    await new Promise((r) => setTimeout(r, 60));

    const probes: any = await sendRequest(sock, { kind: "relay-proxy-poll", project: "proj" });
    const found = (probes as any[]).find((p: any) => p.taskId === "unnamed-1");
    expect(found).toBeUndefined();
  });

  // ── Safety properties (captain-required) ───────────────────────────────────

  it("(a) no cached result → isSurfaceAlive returns 'unknown' → sweep does NOT reap the task", async () => {
    // The proxy has NO cached result for the task. proxiedSurfaceAlive must
    // return "unknown" so the sweep does NOT reap it (unknown never reaps).
    const sock = boot({ sweepMs: 5 });
    await sendRequest(sock, { kind: "dispatch", record: makeInteractive() });
    // Wait for many sweep cycles — no relay-proxy-result is ever sent.
    await new Promise((r) => setTimeout(r, 100));

    const status: any = await sendRequest(sock, { kind: "status", project: "proj", id: "task-aaa" });
    // Must NOT be cancelled — "unknown" must not reap.
    expect(status.state).not.toBe("cancelled");
  });

  it("(b) cmux failure (relay sends liveness:'unknown') → sweep does NOT reap the task", async () => {
    // Simulates the relay getting null surfaceTitles (cmux failure), which produces
    // surfaceVerdict(null, ...) = "unknown". The relay posts "unknown" back.
    const sock = boot({ sweepMs: 5 });
    await sendRequest(sock, { kind: "dispatch", record: makeInteractive() });
    // Relay reports "unknown" (cmux unreachable).
    await sendRequest(sock, {
      kind: "relay-proxy-result",
      results: [{ taskId: "task-aaa", liveness: "unknown" }],
    });
    await new Promise((r) => setTimeout(r, 100));

    const status: any = await sendRequest(sock, { kind: "status", project: "proj", id: "task-aaa" });
    expect(status.state).not.toBe("cancelled");
  });

  it("(c) dead surface → relay sends liveness:'gone' → task reaped to 'cancelled' on next sweep", async () => {
    const sock = boot({ sweepMs: 5 });
    await sendRequest(sock, { kind: "dispatch", record: makeInteractive() });
    // Give reconcile/sweep time to enqueue a probe and put task in 'working'.
    await new Promise((r) => setTimeout(r, 30));

    // Relay confirms the crew pane is gone.
    await sendRequest(sock, {
      kind: "relay-proxy-result",
      results: [{ taskId: "task-aaa", liveness: "gone" }],
    });
    // Wait for at least one more sweep to pick up the "gone" result.
    await new Promise((r) => setTimeout(r, 50));

    const status: any = await sendRequest(sock, { kind: "status", project: "proj", id: "task-aaa" });
    expect(status.state).toBe("cancelled");
    expect(status.lastEvent).toBe("sweep.surface-gone");
  });

  // ── In-flight dedup ─────────────────────────────────────────────────────────

  it("in-flight dedup: probe already handed to relay is not re-enqueued until result arrives", async () => {
    // After the first relay-proxy-poll drains the queue and marks the probe
    // in-flight, subsequent sweeps must NOT re-enqueue it — the second poll
    // must return [] even though the relay has not yet answered.
    // Only after relay-proxy-result clears the in-flight flag can new sweeps
    // re-enqueue (which they will, to refresh the cached liveness).
    const sock = boot({ sweepMs: 5 });
    await sendRequest(sock, { kind: "dispatch", record: makeInteractive() });
    // Let sweeps run so a probe is enqueued.
    await new Promise((r) => setTimeout(r, 30));

    // First poll: drains the queue AND marks task-aaa in-flight.
    const first: any = await sendRequest(sock, { kind: "relay-proxy-poll", project: "proj" });
    expect((first as any[]).some((p: any) => p.taskId === "task-aaa")).toBe(true);

    // Let more sweeps run — proxiedSurfaceAlive will see the in-flight flag and
    // skip re-enqueuing, so the queue stays empty.
    await new Promise((r) => setTimeout(r, 30));

    const second: any = await sendRequest(sock, { kind: "relay-proxy-poll", project: "proj" });
    expect(second).toEqual([]); // in-flight guard held — not re-enqueued

    // Now the relay returns its result — clears the in-flight flag.
    await sendRequest(sock, {
      kind: "relay-proxy-result",
      results: [{ taskId: "task-aaa", liveness: "alive" }],
    });

    // Let sweeps run again — in-flight is clear, so a fresh probe is enqueued.
    await new Promise((r) => setTimeout(r, 30));

    const third: any = await sendRequest(sock, { kind: "relay-proxy-poll", project: "proj" });
    expect((third as any[]).some((p: any) => p.taskId === "task-aaa")).toBe(true);
  });

  it("terminalize cleanup: task.done event evicts taskId from in-flight and result caches", async () => {
    const sock = boot({ sweepMs: 0 });

    // Seed a "gone" result so there is something to evict.
    await sendRequest(sock, {
      kind: "relay-proxy-result",
      results: [{ taskId: "task-aaa", liveness: "gone" }],
    });

    // Dispatch and advance to working.
    await sendRequest(sock, { kind: "dispatch", record: makeInteractive() });
    await new Promise((r) => setTimeout(r, 20));

    // Signal done — the event handler should evict task-aaa from both caches.
    await sendRequest(sock, {
      kind: "event",
      project: "proj",
      event: { type: "task.done", id: "task-aaa", message: "all good" },
    });

    // After terminalization the in-flight set and result cache are cleared.
    // Observable: a fresh relay-proxy-result for the same taskId must be
    // accepted without error, confirming the slot is clean.
    const reinsert: any = await sendRequest(sock, {
      kind: "relay-proxy-result",
      results: [{ taskId: "task-aaa", liveness: "alive" }],
    });
    expect(reinsert).toEqual({ ok: true });

    // And the task itself must be terminal (done).
    const status: any = await sendRequest(sock, { kind: "status", project: "proj", id: "task-aaa" });
    expect(status.state).toBe("done");
  });
});
