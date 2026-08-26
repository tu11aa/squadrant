// #590: the 2026-07-20 outage correlated a deferCount=300 stuck delivery with
// a SIGTERM 180ms later. These tests lock in the properties that make one
// jammed project's delivery unable to hurt anything else:
//   (a) a stuck project never delays another project's delivery in the same tick
//   (b) an exception mid-project is isolated — logged, not propagated
//   (c) once stuck, retries back off (up to 60s) instead of churning every tick,
//       and NEVER drop the message — it still delivers once the blocker clears
// Plus: the exit-marker's inFlightDelivery() accessor (#589), which surfaces
// whichever project/seq was stuck at the moment of a SIGTERM.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loadConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@squadrant/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@squadrant/shared")>();
  return { ...actual, loadConfig: loadConfigMock };
});

import { createDelivery } from "../daemon/delivery-loop.js";
import { createStore } from "../store.js";
import { LivenessRegistry } from "../daemon/liveness-registry.js";
import { appendToMailbox, readFromCursor } from "../mailbox.js";
import { DeferDelivery } from "../delivery/defer-delivery.js";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "deliv-jam-"));
}

function mockConfig(overrides?: Record<string, unknown>) {
  loadConfigMock.mockReturnValue({
    projects: {}, commandName: "🏛️ command",
    delivery: { maxDeferDeliveries: 2, stableProbePolls: 999 },
    ...overrides,
  });
}

async function seed(stateRoot: string, store: ReturnType<typeof createStore>, registry: LivenessRegistry, project: string, message: string) {
  store.put({
    id: `${project}-t1`, project, provider: "claude", mode: "interactive",
    state: "done", task: "t", createdAt: 1, lastHeartbeat: 1,
    lastEvent: "", heartbeatBudgetMs: 1000, attempts: [],
  });
  await appendToMailbox({
    stateRoot, project, taskRecord: store.list(project)[0],
    event: { type: "task.done", id: `${project}-t1` } as any,
    message,
  });
  registry.apply({
    project, role: "captain", pid: 123, sessionId: `s-${project}`,
    startedAt: Date.now(), lastState: "start", lastSeenAt: Date.now(),
    pidAlive: true, source: "runtime",
  });
}

async function rawMailboxTexts(stateRoot: string, project: string): Promise<string[]> {
  const texts: string[] = [];
  for await (const entry of readFromCursor({ stateRoot, project, fromSeq: 1 })) {
    if (entry.message) texts.push(entry.message);
  }
  return texts;
}

describe("delivery-loop per-project jam isolation (#590a)", () => {
  it("a stuck project's deferring delivery never delays another project's delivery in the same tick", async () => {
    const stateRoot = freshState();
    // Object key order drives iteration order — "stuck" is visited before "free".
    mockConfig({ projects: { stuck: { captainName: "stuck-captain" }, free: { captainName: "free-captain" } } });
    const store = createStore(stateRoot);
    const registry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
    await seed(stateRoot, store, registry, "stuck", "CREW DONE stuck");
    await seed(stateRoot, store, registry, "free", "CREW DONE free");

    const sent: string[] = [];
    const cmux = {
      listSurfaces: async (wsId: string) => [{ id: "s1", title: wsId, command: "bash" }],
      findWorkspaceId: async (title: string) => title,
      readScreen: async () => "",
      send: async (surface: any, text: string) => {
        if (surface.title === "stuck-captain") throw new DeferDelivery("draft");
        sent.push(text);
      },
    };
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry: registry, log: () => {}, isPidAlive: () => true, opts: {},
    } as any, cmux as any);

    await deliv.deliveryTick!();

    expect(sent).toEqual(["CREW DONE free"]);
  });
});

describe("delivery-loop per-project exception isolation (#590b)", () => {
  it("a thrown exception resolving one project's surface is caught per-project — later projects still deliver this same tick", async () => {
    const stateRoot = freshState();
    mockConfig({ projects: { boom: { captainName: "boom-captain" }, free2: { captainName: "free2-captain" } } });
    const store = createStore(stateRoot);
    const registry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
    await seed(stateRoot, store, registry, "boom", "CREW DONE boom");
    await seed(stateRoot, store, registry, "free2", "CREW DONE free2");

    const sent: string[] = [];
    const logs: string[] = [];
    const cmux = {
      listSurfaces: async (wsId: string) => [{ id: "s1", title: wsId, command: "bash" }],
      findWorkspaceId: async (title: string) => {
        if (title === "boom-captain") throw new Error("cmux runtime unreachable");
        return title;
      },
      readScreen: async () => "",
      send: async (_surface: any, text: string) => { sent.push(text); },
    };
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry: registry, log: (m: string) => logs.push(m), isPidAlive: () => true, opts: {},
    } as any, cmux as any);

    await expect(deliv.deliveryTick!()).resolves.toBeUndefined();

    expect(sent).toEqual(["CREW DONE free2"]);
    expect(logs.some((l) => l.includes("delivery project=boom") && l.includes("cmux runtime unreachable"))).toBe(true);
  });

  it("keeps retrying the failing project on later ticks — the exception doesn't wedge it permanently", async () => {
    const stateRoot = freshState();
    mockConfig({ projects: { flaky: { captainName: "flaky-captain" } } });
    const store = createStore(stateRoot);
    const registry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
    await seed(stateRoot, store, registry, "flaky", "CREW DONE flaky");

    let fail = true;
    const sent: string[] = [];
    const cmux = {
      listSurfaces: async (wsId: string) => [{ id: "s1", title: wsId, command: "bash" }],
      findWorkspaceId: async (title: string) => { if (fail) throw new Error("transient"); return title; },
      readScreen: async () => "",
      send: async (_surface: any, text: string) => { sent.push(text); },
    };
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry: registry, log: () => {}, isPidAlive: () => true, opts: {},
    } as any, cmux as any);

    await deliv.deliveryTick!();
    expect(sent).toEqual([]);
    fail = false;
    await deliv.deliveryTick!();
    expect(sent).toEqual(["CREW DONE flaky"]);
  });
});

describe("delivery-loop stuck-project backoff (#590c)", () => {
  it("stops retrying every tick once stuck, growing the retry interval up to 60s", async () => {
    vi.useFakeTimers();
    try {
      const stateRoot = freshState();
      mockConfig({ projects: { backoff: { captainName: "backoff-captain" } } }); // maxDeferDeliveries: 2
      const store = createStore(stateRoot);
      const registry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
      await seed(stateRoot, store, registry, "backoff", "CREW DONE backoff");

      let sendCalls = 0;
      let n = 0;
      const cmux = {
        listSurfaces: async (wsId: string) => [{ id: "s1", title: wsId, command: "bash" }],
        findWorkspaceId: async (title: string) => title,
        readScreen: async () => "",
        send: async () => { sendCalls++; throw new DeferDelivery(`typing-${n++}`); },
      };
      const deliv = createDelivery({
        stateRoot, store, livenessRegistry: registry, log: () => {}, isPidAlive: () => true, opts: {},
      } as any, cmux as any);

      await deliv.deliveryTick!(); // defer #1 — not yet stuck (maxDefers=2)
      expect(sendCalls).toBe(1);
      await deliv.deliveryTick!(); // defer #2 — crosses maxDefers=2, now stuck; backoff armed
      expect(sendCalls).toBe(2);

      // Immediately-following ticks (no simulated time passing) must be
      // skipped entirely — no send() call, no churn.
      await deliv.deliveryTick!();
      await deliv.deliveryTick!();
      expect(sendCalls).toBe(2);

      // Advance past the first backoff window (2s at streak=1) — the NEXT
      // tick now fires, and the message is STILL not dropped (still deferred).
      await vi.advanceTimersByTimeAsync(2_000);
      await deliv.deliveryTick!();
      expect(sendCalls).toBe(3);

      // Immediately after that attempt, backoff (now larger) is active again.
      await deliv.deliveryTick!();
      expect(sendCalls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the backoff interval at 60s — never grows unbounded", async () => {
    vi.useFakeTimers();
    try {
      const stateRoot = freshState();
      mockConfig({ projects: { capped: { captainName: "capped-captain" } } });
      const store = createStore(stateRoot);
      const registry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
      await seed(stateRoot, store, registry, "capped", "CREW DONE capped");

      let sendCalls = 0;
      let n = 0;
      const cmux = {
        listSurfaces: async (wsId: string) => [{ id: "s1", title: wsId, command: "bash" }],
        findWorkspaceId: async (title: string) => title,
        readScreen: async () => "",
        send: async () => { sendCalls++; throw new DeferDelivery(`typing-${n++}`); },
      };
      const deliv = createDelivery({
        stateRoot, store, livenessRegistry: registry, log: () => {}, isPidAlive: () => true, opts: {},
      } as any, cmux as any);

      // Drive the backoff streak up well past the point it would exceed 60s
      // uncapped (2^7 * 1s = 128s) by repeatedly advancing time to just past
      // each successive window.
      await deliv.deliveryTick!(); // #1
      await deliv.deliveryTick!(); // #2 — stuck
      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(60_000); // always >= any window, capped or not
        await deliv.deliveryTick!();
      }
      // Every one of those 60s advances should have allowed exactly one
      // attempt each (since 60s always clears a capped window) — total
      // attempts: 2 (initial) + 8 (one per advance).
      expect(sendCalls).toBe(10);

      // Now prove the cap directly: immediately after the last attempt, an
      // advance of 59.9s (just under the 60s cap) must NOT be enough.
      await vi.advanceTimersByTimeAsync(59_900);
      await deliv.deliveryTick!();
      expect(sendCalls).toBe(10);
      await vi.advanceTimersByTimeAsync(200);
      await deliv.deliveryTick!();
      expect(sendCalls).toBe(11);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never drops a terminal kind (CREW DONE) while backed off — delivers the instant the blocker clears", async () => {
    vi.useFakeTimers();
    try {
      const stateRoot = freshState();
      mockConfig({ projects: { recovers: { captainName: "recovers-captain" } } });
      const store = createStore(stateRoot);
      const registry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
      await seed(stateRoot, store, registry, "recovers", "CREW DONE recovers");

      let blocked = true;
      let n = 0;
      const sent: string[] = [];
      const cmux = {
        listSurfaces: async (wsId: string) => [{ id: "s1", title: wsId, command: "bash" }],
        findWorkspaceId: async (title: string) => title,
        readScreen: async () => "",
        send: async (_s: any, text: string) => {
          if (blocked) throw new DeferDelivery(`typing-${n++}`);
          sent.push(text);
        },
      };
      const deliv = createDelivery({
        stateRoot, store, livenessRegistry: registry, log: () => {}, isPidAlive: () => true, opts: {},
      } as any, cmux as any);

      await deliv.deliveryTick!(); // defer #1
      await deliv.deliveryTick!(); // defer #2 — stuck, backoff armed
      await deliv.deliveryTick!(); // skipped (backing off)
      expect(sent).toEqual([]);

      // Blocker clears while still "backing off" in wall-clock terms — the
      // very next attempt (once the backoff window passes) must deliver, not
      // stay skipped forever.
      blocked = false;
      await vi.advanceTimersByTimeAsync(2_000);
      await deliv.deliveryTick!();
      // The recovery tick also drains the DELIVERY STUCK alert appended while
      // stuck (a separate mailbox entry) — assert the original message made
      // it through, not that it was the ONLY thing delivered.
      expect(sent).toContain("CREW DONE recovers");

      const texts = await rawMailboxTexts(stateRoot, "recovers");
      expect(texts).toContain("CREW DONE recovers");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("delivery-loop inFlightDelivery accessor (#589)", () => {
  it("returns null when nothing is deferred", () => {
    const stateRoot = freshState();
    mockConfig();
    const store = createStore(stateRoot);
    const registry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
    const cmux = { listSurfaces: async () => [], findWorkspaceId: async () => null, send: async () => {} };
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry: registry, log: () => {}, isPidAlive: () => true, opts: {},
    } as any, cmux as any);

    expect(deliv.inFlightDelivery()).toBeNull();
  });

  it("returns null when there is no daemonCmux at all (daemon-direct mode off)", () => {
    mockConfig();
    const store = createStore(freshState());
    const deliv = createDelivery({ stateRoot: freshState(), store, log: () => {}, isPidAlive: () => true, opts: {} } as any, undefined);
    expect(deliv.inFlightDelivery()).toBeNull();
  });

  it("reports the deferred project/seq/deferCount after a defer, and clears to null once delivered", async () => {
    const stateRoot = freshState();
    mockConfig({ projects: { inflight: { captainName: "inflight-captain" } } });
    const store = createStore(stateRoot);
    const registry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
    await seed(stateRoot, store, registry, "inflight", "CREW DONE inflight");

    let fail = true;
    const cmux = {
      listSurfaces: async (wsId: string) => [{ id: "s1", title: wsId, command: "bash" }],
      findWorkspaceId: async (title: string) => title,
      send: async () => { if (fail) throw new DeferDelivery("draft"); },
    };
    const deliv = createDelivery({
      stateRoot, store, livenessRegistry: registry, log: () => {}, isPidAlive: () => true, opts: {},
    } as any, cmux as any);

    await deliv.deliveryTick!();
    expect(deliv.inFlightDelivery()).toEqual({ project: "inflight", seq: 1, deferCount: 1 });

    fail = false;
    await deliv.deliveryTick!();
    expect(deliv.inFlightDelivery()).toBeNull();
  });

  it("reports the WORST (highest deferCount) in-flight delivery across multiple stuck projects, ignoring ones that already recovered", async () => {
    vi.useFakeTimers();
    try {
      const stateRoot = freshState();
      mockConfig({ projects: { worse: { captainName: "worse-captain" }, milder: { captainName: "milder-captain" } } });
      const store = createStore(stateRoot);
      const registry = new LivenessRegistry({ path: join(stateRoot, "live.json") });
      await seed(stateRoot, store, registry, "worse", "CREW DONE worse");
      await seed(stateRoot, store, registry, "milder", "CREW DONE milder");

      let milderBlocked = true;
      const cmux = {
        listSurfaces: async (wsId: string) => [{ id: "s1", title: wsId, command: "bash" }],
        findWorkspaceId: async (title: string) => title,
        send: async (surface: any) => {
          if (surface.title === "worse-captain") throw new DeferDelivery("draft-worse");
          if (milderBlocked) throw new DeferDelivery("draft-milder");
        },
      };
      const deliv = createDelivery({
        stateRoot, store, livenessRegistry: registry, log: () => {}, isPidAlive: () => true, opts: {},
      } as any, cmux as any);

      await deliv.deliveryTick!(); // both defer once
      milderBlocked = false;
      await deliv.deliveryTick!(); // milder delivers and clears; worse defers again (now stuck, backoff armed)
      // worse's backoff window (2s) must pass before its 3rd attempt fires.
      await vi.advanceTimersByTimeAsync(2_000);
      await deliv.deliveryTick!(); // worse defers a 3rd time

      // milder recovered and is no longer in flight at all — only "worse" remains.
      expect(deliv.inFlightDelivery()).toEqual({ project: "worse", seq: 1, deferCount: 3 });
    } finally {
      vi.useRealTimers();
    }
  });
});
