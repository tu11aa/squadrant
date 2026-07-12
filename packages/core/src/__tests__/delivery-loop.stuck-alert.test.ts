// #579/#484: probe escalation now defers FOREVER while a captain's draft (real
// or ghost) is actively changing — the correct, safe behaviour. But safe-and-
// silent is exactly #560's disease ("stalls silently, forever, invisible unless
// a human happens to open the dashboard"). These tests assert the daemon fails
// LOUD instead: a real, edge-triggered captain.message alert once delivery
// crosses maxDefers for a project — never per-poll (the #492 flood class), and
// re-arms so a LATER stall episode alerts again.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loadConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@squadrant/shared")>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

import { createDelivery } from "../daemon/delivery-loop.js";
import { createStore } from "../store.js";
import { LivenessRegistry } from "../daemon/liveness-registry.js";
import { appendToMailbox, readFromCursor } from "../mailbox.js";
import { DeferDelivery } from "../delivery/defer-delivery.js";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "deliv-stuck-"));
}

// Small maxDefers/high stableProbePolls so a handful of ticks with CHANGING
// content (never stable) crosses the stuck threshold without ever escalating
// to a probe — isolates the "stuck" alert from the #484 probe-escalation logic.
function mockConfig(overrides?: Record<string, unknown>) {
  loadConfigMock.mockReturnValue({
    projects: {}, commandName: "🏛️ command",
    delivery: { maxDeferDeliveries: 2, stableProbePolls: 999 },
    ...overrides,
  });
}

async function rawMailboxTexts(stateRoot: string, project: string): Promise<string[]> {
  const texts: string[] = [];
  for await (const entry of readFromCursor({ stateRoot, project, fromSeq: 1 })) {
    if (entry.message) texts.push(entry.message);
  }
  return texts;
}

describe("delivery-loop stuck-delivery alert (#579/#484)", () => {
  it("emits exactly one captain.message alert once deferCount crosses maxDefers — not once per poll", async () => {
    const stateRoot = freshState();
    const project = "alpha";
    const captainName = `${project}-captain`;
    mockConfig({ projects: { [project]: { captainName } } });
    const store = createStore(stateRoot);
    store.put({
      id: "t1", project, provider: "claude", mode: "interactive",
      state: "done", task: "t", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000, attempts: [],
    });
    await appendToMailbox({
      stateRoot, project, taskRecord: store.list(project)[0],
      event: { type: "task.done", id: "t1" } as any,
      message: "CREW DONE t1",
    });
    const livenessRegistry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
    livenessRegistry.apply({
      project, role: "captain", pid: 123, sessionId: "s1",
      startedAt: Date.now(), lastState: "start", lastSeenAt: Date.now(),
      pidAlive: true, source: "runtime",
    });

    let n = 0;
    const cmux = {
      listSurfaces: async () => [{ id: "s1", title: captainName, command: "bash" }],
      findWorkspaceId: async () => "w1",
      readScreen: async () => `${captainName}> `,
      // Content changes every call — an actively-typing captain, never stable —
      // so only the maxDefers-crossing edge can trip the alert, never a probe.
      send: async () => { throw new DeferDelivery(`typing-${n++}`); },
    };
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {},
    } as any, cmux as any);

    // 6 ticks: well past maxDefers=2 — the alert must fire exactly once, not 4+ times.
    for (let i = 0; i < 6; i++) await deliv.deliveryTick!();

    const texts = await rawMailboxTexts(stateRoot, project);
    const alerts = texts.filter((t) => t.includes("DELIVERY STUCK"));
    expect(alerts).toHaveLength(1);
  });

  it("does not alert while delivery is healthy (never stuck)", async () => {
    const stateRoot = freshState();
    const project = "beta";
    const captainName = `${project}-captain`;
    mockConfig({ projects: { [project]: { captainName } } });
    const store = createStore(stateRoot);
    store.put({
      id: "t1", project, provider: "claude", mode: "interactive",
      state: "done", task: "t", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000, attempts: [],
    });
    await appendToMailbox({
      stateRoot, project, taskRecord: store.list(project)[0],
      event: { type: "task.done", id: "t1" } as any,
      message: "CREW DONE t1",
    });
    const livenessRegistry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
    livenessRegistry.apply({
      project, role: "captain", pid: 123, sessionId: "s1",
      startedAt: Date.now(), lastState: "start", lastSeenAt: Date.now(),
      pidAlive: true, source: "runtime",
    });
    const cmux = {
      listSurfaces: async () => [{ id: "s1", title: captainName, command: "bash" }],
      findWorkspaceId: async () => "w1",
      readScreen: async () => `${captainName}> `,
      send: async () => {}, // delivers immediately, every time
    };
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {},
    } as any, cmux as any);

    for (let i = 0; i < 5; i++) await deliv.deliveryTick!();

    const texts = await rawMailboxTexts(stateRoot, project);
    expect(texts.some((t) => t.includes("DELIVERY STUCK"))).toBe(false);
  });

  it("re-arms after recovery — a second, later stall episode alerts again", async () => {
    const stateRoot = freshState();
    const project = "gamma";
    const captainName = `${project}-captain`;
    mockConfig({ projects: { [project]: { captainName } } });
    const store = createStore(stateRoot);
    store.put({
      id: "t1", project, provider: "claude", mode: "interactive",
      state: "done", task: "t", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000, attempts: [],
    });
    await appendToMailbox({
      stateRoot, project, taskRecord: store.list(project)[0],
      event: { type: "task.done", id: "t1" } as any,
      message: "CREW DONE t1",
    });
    const livenessRegistry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
    livenessRegistry.apply({
      project, role: "captain", pid: 123, sessionId: "s1",
      startedAt: Date.now(), lastState: "start", lastSeenAt: Date.now(),
      pidAlive: true, source: "runtime",
    });

    let stuck = true;
    let n = 0;
    const cmux = {
      listSurfaces: async () => [{ id: "s1", title: captainName, command: "bash" }],
      findWorkspaceId: async () => "w1",
      readScreen: async () => `${captainName}> `,
      send: async (_s: any, text: string) => {
        if (stuck) throw new DeferDelivery(`typing-${n++}`);
        // recovered: delivers normally
      },
    };
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {},
    } as any, cmux as any);

    // First stall episode: crosses maxDefers=2, alerts once.
    for (let i = 0; i < 4; i++) await deliv.deliveryTick!();
    let texts = await rawMailboxTexts(stateRoot, project);
    expect(texts.filter((t) => t.includes("DELIVERY STUCK"))).toHaveLength(1);

    // Recover: the original entry finally delivers, clearing the stuck flag.
    stuck = false;
    await deliv.deliveryTick!();

    // New task, new stall episode.
    store.put({
      id: "t2", project, provider: "claude", mode: "interactive",
      state: "done", task: "t2", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000, attempts: [],
    });
    await appendToMailbox({
      stateRoot, project, taskRecord: store.list(project)[0],
      event: { type: "task.done", id: "t2" } as any,
      message: "CREW DONE t2",
    });
    stuck = true;
    for (let i = 0; i < 4; i++) await deliv.deliveryTick!();

    texts = await rawMailboxTexts(stateRoot, project);
    expect(texts.filter((t) => t.includes("DELIVERY STUCK"))).toHaveLength(2);
  });
});
