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

  it("pushes the alert out-of-band via telegramBridge — reaches the operator WHILE still stuck, not queued behind the same blocked pane", async () => {
    // The mailbox entry alone doesn't work: it's drained by this same stuck
    // delivery pipeline, so it queues behind the very block it's reporting.
    // telegramBridge.pushRaw never touches the pane/mailbox, so it must fire
    // on the SAME tick that crosses maxDefers — before the draft ever clears.
    const stateRoot = freshState();
    const project = "delta";
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
      send: async () => { throw new DeferDelivery(`typing-${n++}`); },
    };
    const pushRaw = vi.fn();
    const telegramBridge = { start: vi.fn(), stop: vi.fn(), pushLifecycle: vi.fn(), pushRaw, health: vi.fn() };
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {}, telegramBridge,
    } as any, cmux as any);

    // Still stuck (draft never clears) — the mailbox alert would still be
    // queued behind the block, but pushRaw must already have fired.
    for (let i = 0; i < 6; i++) await deliv.deliveryTick!();

    expect(pushRaw).toHaveBeenCalledTimes(1);
    expect(pushRaw).toHaveBeenCalledWith(project, expect.stringContaining("DELIVERY STUCK"));
  });

  it("#579/#484 Gap 1: pushes the alert via notifyFault even with NO telegramBridge configured — the config-free channel every install has", async () => {
    // Most installs have no Telegram set up. Before this fix, the ONLY
    // out-of-band channel was `telegramBridge?.pushRaw` — undefined bridge
    // meant that call silently no-op'd, leaving the alert with no channel
    // that could reach the operator while still stuck (appendCaptainMessage
    // queues behind the same block). notifyFault must be resolved and called
    // regardless of whether telegramBridge is injected at all.
    const stateRoot = freshState();
    const project = "epsilon";
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
      send: async () => { throw new DeferDelivery(`typing-${n++}`); },
    };
    const notifyFault = vi.fn();
    const deliv = createDelivery({
      // NOTE: no telegramBridge key at all — proves this doesn't depend on it.
      stateRoot, store, livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {}, notifyFault,
    } as any, cmux as any);

    for (let i = 0; i < 6; i++) await deliv.deliveryTick!();

    expect(notifyFault).toHaveBeenCalledTimes(1);
    expect(notifyFault).toHaveBeenCalledWith(project, expect.stringContaining("DELIVERY STUCK"));
  });

  it("re-arms after recovery — a second, later stall episode alerts again", async () => {
    vi.useFakeTimers();
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
    // #590: once stuck, the project is backed off for a window (grows up to
    // 60s) before the next attempt — advance past it so recovery is actually
    // attempted rather than skipped.
    stuck = false;
    await vi.advanceTimersByTimeAsync(2_000);
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
    for (let i = 0; i < 4; i++) {
      await deliv.deliveryTick!();
      await vi.advanceTimersByTimeAsync(2_000);
    }

    texts = await rawMailboxTexts(stateRoot, project);
    expect(texts.filter((t) => t.includes("DELIVERY STUCK"))).toHaveLength(2);
    vi.useRealTimers();
  });

  // #617: the stuck message hardcoded "an in-progress draft (or ghost text)
  // in your input box" even when the actual blocker was a modal (#484) — an
  // open AskUserQuestion/permission picker, not the operator's input box.
  // Pointing the operator at the wrong place is actively misleading.
  it("reports 'a modal question is open' when the blocker classification is modal, not the input-box wording (#617)", async () => {
    const stateRoot = freshState();
    const project = "zeta";
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
      send: async () => { throw new DeferDelivery(null, "modal"); },
    };
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {},
    } as any, cmux as any);

    for (let i = 0; i < 6; i++) await deliv.deliveryTick!();

    const texts = await rawMailboxTexts(stateRoot, project);
    const alert = texts.find((t) => t.includes("DELIVERY STUCK"));
    expect(alert).toContain("a modal question is open in your captain pane");
    expect(alert).not.toContain("input box");
  });

  it("keeps the input-box wording when the blocker classification is draft/ghost (#617)", async () => {
    const stateRoot = freshState();
    const project = "eta";
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
      send: async () => { throw new DeferDelivery(`typing-${n++}`, "draft"); },
    };
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {},
    } as any, cmux as any);

    for (let i = 0; i < 6; i++) await deliv.deliveryTick!();

    const texts = await rawMailboxTexts(stateRoot, project);
    const alert = texts.find((t) => t.includes("DELIVERY STUCK"));
    expect(alert).toContain("an in-progress draft (or ghost text) in your input box");
  });

});

// #714: the DELIVERY STUCK alert was binary — modal got one sentence, EVERY
// other reason got the draft wording, so a no-box jam told the operator to go
// clear a draft that did not exist (the 2026-08-22 incident). The alert text
// must reflect the actual DeferReason that fired, with a distinct sentence
// for each of the four.
describe("delivery-loop stuck-delivery alert reason-specific wording (#714)", () => {
  async function alertForReason(reason: "no-box" | "modal" | "draft" | "probe-failed"): Promise<string> {
    const stateRoot = freshState();
    const project = `reason-${reason}`;
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
      listSurfaces: async () => [{ workspaceId: "w1", surfaceId: "surface:1", title: captainName }],
      findWorkspaceId: async () => "w1",
      send: async () => { throw new DeferDelivery(null, reason); },
    };
    const notifyFault = vi.fn();
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry, log: () => {}, isPidAlive: () => true, opts: {}, notifyFault,
    } as any, cmux as any);

    for (let i = 0; i < 6; i++) await deliv.deliveryTick!();
    expect(notifyFault).toHaveBeenCalledTimes(1);
    return notifyFault.mock.calls[0][1] as string;
  }

  it("no-box names the unconfirmed-visible input box", async () => {
    const alert = await alertForReason("no-box");
    expect(alert).toContain("input box could not be confirmed visible");
    expect(alert).not.toContain("in-progress draft");
  });

  it("modal names the open question modal", async () => {
    const alert = await alertForReason("modal");
    expect(alert).toContain("a modal question is open");
    expect(alert).not.toContain("input box");
  });

  it("draft names the in-progress draft/ghost", async () => {
    const alert = await alertForReason("draft");
    expect(alert).toContain("an in-progress draft (or ghost text) in your input box");
  });

  it("probe-failed names the failed screen probe / stale surface, not a UI condition", async () => {
    const alert = await alertForReason("probe-failed");
    expect(alert).toContain("reading your captain pane failed");
    expect(alert).not.toContain("draft");
    expect(alert).not.toContain("input box");
  });

  it("all four reason texts are pairwise distinct", async () => {
    const reasons = ["no-box", "modal", "draft", "probe-failed"] as const;
    const alerts = await Promise.all(reasons.map((r) => alertForReason(r)));
    expect(new Set(alerts).size).toBe(4);
  });
});
