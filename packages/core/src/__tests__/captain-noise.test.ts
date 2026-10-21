// #1017: captain-pane noise reduction — classifier, tier gate, digest, stall episodes, replay.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlEvent, CrewTier, TaskRecord } from "@squadrant/shared";
import { classifyTurnEnd, captainPaneAllows, InformationalDigest, isInformational } from "../daemon/captain-noise.js";
import { createDaemon, DEFAULT_STALL_ESCALATION_MS } from "../daemon/reduce.js";
import { createDelivery } from "../daemon/delivery-loop.js";
import { coalesceBacklog } from "../daemon/backlog-coalesce.js";
import { createStore } from "../store.js";
import { mailboxStats, readFromCursor, type MailboxEntry } from "../mailbox.js";

const MIN = 60_000;

function rec(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id, project: "demo", provider: "claude", mode: "interactive",
    state: "working", task: "t", createdAt: 1, lastHeartbeat: 1, firstTurnConfirmedAt: 1,
    lastEvent: "", heartbeatBudgetMs: 5 * MIN,
    attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
    ...overrides,
  };
}

describe("classifyTurnEnd (#1017)", () => {
  it("plain statement → plain", () => {
    expect(classifyTurnEnd("Pushed the branch. Tests pass.")).toBe("plain");
    expect(classifyTurnEnd("")).toBe("plain");
    expect(classifyTurnEnd(undefined)).toBe("plain");
  });
  it("last line ending in ? → addressed", () => {
    expect(classifyTurnEnd("Two options.\nShall I rebase first?")).toBe("addressed");
  });
  it("a ? inside a code fence is ignored", () => {
    expect(classifyTurnEnd("Done.\n```\nwhy?\n```")).toBe("plain");
  });
  it("is language-neutral: no keyword rule", () => {
    expect(classifyTurnEnd("Captain: PR is ready for review.")).toBe("plain");
    expect(classifyTurnEnd("Xong, đã sửa A và B.\nBạn muốn merge luôn không?")).toBe("addressed");
  });
});

describe("captainPaneAllows (#1017)", () => {
  const idle: ControlEvent = { type: "task.turn.completed", id: "t", turnId: "1", lastMessage: "ok" };
  const addressed: ControlEvent = { type: "task.turn.completed", id: "t", turnId: "1", lastMessage: "Ready?" };
  const reply: ControlEvent = { type: "task.turn.completed", id: "t", turnId: "1", lastMessage: "Done: changed A and B.", reply: true };
  const noText: ControlEvent = { type: "task.turn.completed", id: "t", turnId: "1" };
  const stalled: ControlEvent = { type: "task.stalled", id: "t", heartbeatBudgetMs: 1, tool: "Bash" };
  const escalated: ControlEvent = { ...stalled, escalated: true } as ControlEvent;
  const quiet: ControlEvent = { type: "task.quiet", id: "t", quietMs: 1 };
  const cases: Array<[string, ControlEvent, Record<CrewTier, boolean>]> = [
    ["plain idle", idle, { none: false, done_only: false, alert_only: false, all: true }],
    ["reply to captain (plain text)", reply, { none: false, done_only: false, alert_only: true, all: true }],
    ["turn-end with no text (codex/opencode)", noText, { none: false, done_only: false, alert_only: true, all: true }],
    ["addressed idle", addressed, { none: false, done_only: false, alert_only: true, all: true }],
    ["first stall", stalled, { none: false, done_only: false, alert_only: false, all: true }],
    ["escalated stall", escalated, { none: false, done_only: false, alert_only: true, all: true }],
    ["quiet", quiet, { none: false, done_only: false, alert_only: false, all: true }],
    ["turn failed", { type: "task.turn.failed", id: "t", turnId: "1", error: "529" }, { none: false, done_only: false, alert_only: true, all: true }],
    ["done", { type: "task.done", id: "t" } as ControlEvent, { none: false, done_only: true, alert_only: true, all: true }],
    ["blocked", { type: "task.blocked", id: "t", reason: "r", question: "q" } as ControlEvent, { none: false, done_only: false, alert_only: true, all: true }],
    ["review", { type: "task.review", id: "t" } as ControlEvent, { none: false, done_only: false, alert_only: true, all: true }],
    ["warn (undelivered/probe)", { type: "task.warn", id: "t", message: "m" }, { none: false, done_only: false, alert_only: true, all: true }],
    ["notify-only progress (held-long nudge)", { type: "task.progress", id: "t" } as ControlEvent, { none: false, done_only: false, alert_only: true, all: true }],
  ];
  for (const [name, ev, expected] of cases) {
    it(name, () => {
      for (const tier of Object.keys(expected) as CrewTier[]) {
        expect(captainPaneAllows(tier, ev), `${name} @ ${tier}`).toBe(expected[tier]);
      }
    });
  }
  it("task.warn is not informational (never digested)", () => {
    expect(isInformational({ type: "task.warn", id: "t", message: "m" })).toBe(false);
  });
});

describe("InformationalDigest (#1017)", () => {
  afterEach(() => vi.useRealTimers());
  it("coalesces N events for one crew into a single digest after the quiet window", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const d = new InformationalDigest((_k, m) => out.push(m), 60_000);
    const ev: ControlEvent = { type: "task.quiet", id: "t", quietMs: 1 };
    for (let i = 0; i < 5; i++) { d.push("p:t", "[claude/x]", ev, `m${i}`); vi.advanceTimersByTime(10_000); }
    expect(out).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/CREW DIGEST \[claude\/x\]: 5 quiet/);
    expect(out[0]).toMatch(/latest: m4/);
  });
  it("flush releases early and only once", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const d = new InformationalDigest((_k, m) => out.push(m), 60_000);
    d.push("p:t", "[c]", { type: "task.stalled", id: "t", heartbeatBudgetMs: 1 }, "s");
    d.flush("p:t"); d.flush("p:t");
    vi.advanceTimersByTime(120_000);
    expect(out).toHaveLength(1);
  });
});

describe("stall episodes + hard escalation (#1017)", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "noise-"));
    const store = createStore(dir);
    const calls: Array<{ message: string; event: ControlEvent }> = [];
    let t = 0;
    const d = createDaemon({ store, now: () => t, notify: async (a) => { calls.push(a); } });
    return { store, calls, d, at: (ms: number) => { t = ms; } };
  }

  it("first stall fires once; re-stalling on the same tool in the same turn does not repeat", async () => {
    const { store, calls, d, at } = setup();
    store.put(rec("s1", { pendingTool: { name: "Bash", since: 0 } }));
    at(11 * MIN); await d.sweep();
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toMatch(/CREW STALLED.*still running Bash ~11min/);
    // recover to working (tool returned), then another Bash hangs past budget
    store.put(rec("s1", { pendingTool: { name: "Bash", since: 12 * MIN }, lastHeartbeat: 12 * MIN }));
    at(23 * MIN); await d.sweep();
    expect(calls).toHaveLength(1);
  });

  it("a turn boundary ends the episode: a later stall notifies again", async () => {
    const { store, calls, d, at } = setup();
    store.put(rec("s2", { pendingTool: { name: "Bash", since: 0 } }));
    at(11 * MIN); await d.sweep();
    store.put(rec("s2", { state: "working", lastHeartbeat: 12 * MIN }));
    at(12 * MIN);
    await d.handle({ kind: "event", project: "demo", event: { type: "task.turn.completed", id: "s2", turnId: "1" } });
    store.put(rec("s2", { pendingTool: { name: "Bash", since: 13 * MIN }, lastHeartbeat: 13 * MIN }));
    at(25 * MIN); await d.sweep();
    expect(calls.filter((c) => c.event.type === "task.stalled")).toHaveLength(2);
  });

  it("hard escalation surfaces exactly once at the budget, never before, never again", async () => {
    const { store, calls, d, at } = setup();
    store.put(rec("s3", { pendingTool: { name: "Bash", since: 0 } }));
    at(11 * MIN); await d.sweep();
    at(20 * MIN); await d.sweep();
    expect(calls).toHaveLength(1);
    at(DEFAULT_STALL_ESCALATION_MS + MIN); await d.sweep();
    expect(calls).toHaveLength(2);
    expect(calls[1].event).toMatchObject({ type: "task.stalled", escalated: true, tool: "Bash" });
    expect(calls[1].message).toMatch(/ESCALATION.*~31min.*Bash/);
    at(60 * MIN); await d.sweep();
    at(90 * MIN); await d.sweep();
    expect(calls).toHaveLength(2);
  });

  it("stallEscalationMs is configurable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noise-"));
    const store = createStore(dir);
    const calls: ControlEvent[] = [];
    let t = 0;
    const d = createDaemon({ store, now: () => t, stallEscalationMs: 15 * MIN, notify: async (a) => { calls.push(a.event); } });
    store.put(rec("s4", { pendingTool: { name: "Bash", since: 0 } }));
    t = 11 * MIN; await d.sweep();
    t = 16 * MIN; await d.sweep();
    expect(calls.map((e) => (e as any).escalated ?? false)).toEqual([false, true]);
  });
});

describe("content-carrying idle (#1017)", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "noise-"));
    const store = createStore(dir);
    const calls: Array<{ message: string; event: ControlEvent }> = [];
    let t = 100_000;
    const d = createDaemon({ store, now: () => t, notify: async (a) => { calls.push(a); } });
    const ev = (e: ControlEvent) => d.handle({ kind: "event", project: "demo", event: e });
    return { store, calls, ev, adv: (ms: number) => { t += ms; } };
  }
  const end = (id: string, n: number, lastMessage?: string): ControlEvent =>
    ({ type: "task.turn.completed", id, turnId: String(n), ...(lastMessage ? { lastMessage } : {}) });

  it("a question turn-end carries the text word for word and bypasses the #210 debounce", async () => {
    const { store, calls, ev, adv } = setup();
    store.put(rec("i1"));
    await ev({ type: "task.started", id: "i1" });
    adv(1000);
    const text = "Found two failing specs.\nShould I fix them here or file a follow-up?";
    await ev(end("i1", 1, text));
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain(text);
  });

  it("a plain-text reply right after a captain message is delivered word for word", async () => {
    const { store, calls, ev, adv } = setup();
    store.put(rec("i2"));
    await ev({ type: "task.started", id: "i2" }); // captain spoke (crew send)
    adv(60_000); // well outside the debounce window
    await ev(end("i2", 1, "Done: changed A and B, tests pass."));
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain("Done: changed A and B, tests pass.");
  });

  it("a later self-resume turn-end with no captain message in between is silent-class (plain)", async () => {
    const { store, calls, ev, adv } = setup();
    store.put(rec("i3"));
    await ev({ type: "task.started", id: "i3" });
    adv(60_000);
    await ev(end("i3", 1, "Done: A."));          // the reply
    await ev({ type: "task.turn.started", id: "i3", turnId: "2" }); // self-resume
    await ev(end("i3", 2, "Also tidied B."));
    expect(calls).toHaveLength(2); // both reach notify; the pane tier drops the second
    expect(captainPaneAllows("alert_only", calls[0].event)).toBe(true);
    expect(captainPaneAllows("alert_only", calls[1].event)).toBe(false);
    expect((calls[1].event as any).reply).toBeUndefined();
  });

  it("a turn-end with no lastMessage (provider with no text source) is delivered as the generic CREW IDLE", async () => {
    const { store, calls, ev, adv } = setup();
    store.put(rec("i4", { provider: "opencode" as any }));
    adv(60_000);
    await ev(end("i4", 1));
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toMatch(/CREW IDLE.*awaiting your reply/);
    expect(captainPaneAllows("alert_only", calls[0].event)).toBe(true);
  });

  it("a plain turn-end inside the debounce window is still suppressed (no text → debounced as today)", async () => {
    const { store, calls, ev, adv } = setup();
    store.put(rec("i5"));
    await ev({ type: "task.started", id: "i5" });
    await ev(end("i5", 0, "first")); // consume the reply
    calls.length = 0;
    await ev({ type: "task.started", id: "i5" });
    adv(1000);
    await ev(end("i5", 1));
    expect(calls).toHaveLength(0);
  });
});

describe("captain-pane delivery + replay (#1017)", () => {
  afterEach(() => vi.useRealTimers());

  function wire(tier: CrewTier, idleTextGraceMs = 5000) {
    const stateRoot = mkdtempSync(join(tmpdir(), "noise-"));
    const store = createStore(stateRoot);
    const { defaultNotify } = createDelivery(
      { stateRoot, store, log: () => {}, isPidAlive: () => true, opts: { captainCrewTier: () => tier, captainDigestWindowMs: 60_000 } } as any,
      undefined,
    );
    let t = 1_000_000;
    // the daemon fires notify without awaiting it — track writes so tests can drain them
    const inFlight: Array<Promise<void>> = [];
    const d = createDaemon({ store, now: () => t, idleTextGraceMs, notify: (a) => { const p = Promise.resolve(defaultNotify(a)); inFlight.push(p); return p; } });
    return { stateRoot, store, d, inFlight, at: (ms: number) => { t = ms; }, tick: (ms: number) => { t += ms; return t; } };
  }

  async function entries(w: ReturnType<typeof wire>): Promise<MailboxEntry[]> {
    await Promise.all(w.inFlight);
    const stateRoot = w.stateRoot;
    const out: MailboxEntry[] = [];
    for await (const e of readFromCursor({ stateRoot, project: "demo", fromSeq: 0 })) out.push(e);
    return out;
  }

  // The reported session: 10 idle + 4 stalled + 1 quiet from one crew.
  async function replay(w: ReturnType<typeof wire>) {
    const { store, d, tick } = w;
    store.put(rec("r1", { lastHeartbeat: 1_000_000 }));
    for (let i = 0; i < 10; i++) {
      await d.handle({ kind: "event", project: "demo", event: { type: "task.turn.started", id: "r1", turnId: String(i) } });
      tick(30_000);
      await d.handle({ kind: "event", project: "demo", event: { type: "task.turn.completed", id: "r1", turnId: String(i), lastMessage: `Finished step ${i}.` } });
      tick(30_000);
      if (i % 3 === 2) { // a stall on a long Bash, then it recovers
        const now = tick(0);
        store.put(rec("r1", { pendingTool: { name: "Bash", since: now - 11 * MIN }, lastHeartbeat: now - 11 * MIN, lastEvent: "task.progress" }));
        await d.sweep();
        store.put(rec("r1", { state: "working", lastHeartbeat: now, lastEvent: "task.progress" }));
      }
    }
    // one quiet episode
    const now = tick(10 * MIN);
    store.put(rec("r1", { state: "working", lastHeartbeat: now - 10 * MIN, attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: now - 10 * MIN }] }));
    await d.sweep();
    // the crew finally asks the captain something, then finishes
    await d.handle({ kind: "event", project: "demo", event: { type: "task.turn.started", id: "r1", turnId: "q" } });
    await d.handle({ kind: "event", project: "demo", event: { type: "task.turn.completed", id: "r1", turnId: "q", lastMessage: "Tests pass. Merge now or wait for CI?" } });
    await d.handle({ kind: "event", project: "demo", event: { type: "task.done", id: "r1", resultRef: "/r" } });
  }

  it("default tier: 15 informational events + 1 question + done → 2 captain deliveries, nothing actionable lost", async () => {
    const w = wire("alert_only");
    await replay(w);
    const got = await entries(w);
    expect(got.length).toBeLessThanOrEqual(3);
    expect(got.map((e) => e.message).join("\n")).toMatch(/Merge now or wait for CI\?/);
    expect(got.some((e) => e.kind === "task.done")).toBe(true);
    expect(got.some((e) => /CREW (IDLE|QUIET|STALLED)/.test(e.message ?? "") && !/Merge now/.test(e.message ?? ""))).toBe(false);
    // the record still carries the truth for `crew tasks`
    expect(w.store.get("demo", "r1")?.state).toBe("done");
  });

  it("tier all: informational events coalesce into one digest per crew", async () => {
    vi.useFakeTimers();
    const w = wire("all");
    const { store, d } = w;
    store.put(rec("r2"));
    for (let i = 0; i < 6; i++) {
      await d.handle({ kind: "event", project: "demo", event: { type: "task.turn.started", id: "r2", turnId: String(i) } });
      await d.handle({ kind: "event", project: "demo", event: { type: "task.turn.completed", id: "r2", turnId: String(i), lastMessage: "ok" } });
    }
    expect(await entries(w)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(61_000);
    vi.useRealTimers(); // the digest's mailbox write is untracked real I/O
    await vi.waitFor(async () => expect(await entries(w)).toHaveLength(1));
    const got = await entries(w);
    expect(got[0].message).toMatch(/CREW DIGEST.*6 idle/);
  });

  it("tier all: an actionable event flushes the crew's digest first (order kept)", async () => {
    vi.useFakeTimers();
    const w = wire("all");
    w.store.put(rec("r3"));
    await w.d.handle({ kind: "event", project: "demo", event: { type: "task.turn.started", id: "r3", turnId: "1" } });
    await w.d.handle({ kind: "event", project: "demo", event: { type: "task.turn.completed", id: "r3", turnId: "1", lastMessage: "ok" } });
    await w.d.handle({ kind: "event", project: "demo", event: { type: "task.blocked", id: "r3", reason: "r", question: "which db?" } });
    const got = await entries(w);
    expect(got.map((e) => (e.message ?? "").split(" ").slice(0, 2).join(" "))).toEqual(["CREW DIGEST", "CREW BLOCKED"]);
  });

  it("tier none drops everything, even CREW DONE", async () => {
    const w = wire("none");
    w.store.put(rec("r4", { state: "awaiting-input" }));
    await w.d.handle({ kind: "event", project: "demo", event: { type: "task.done", id: "r4", resultRef: "/r" } });
    expect((await mailboxStats((await entries(w), w.stateRoot), "demo")).maxSeq).toBe(0);
  });
});

describe("backlog coalescing keeps addressed turn-ends (#1017)", () => {
  const e = (seq: number, kind: MailboxEntry["kind"], payload: Record<string, unknown> = {}): MailboxEntry =>
    ({ seq, ts: new Date(1000).toISOString(), taskId: "t", kind, provider: "claude", payload, message: `m${seq}` });
  it("drops a superseded plain idle but never an addressed one", () => {
    const entries = [
      e(1, "task.turn.completed", { lastMessage: "ok" }),
      e(2, "task.turn.completed", { lastMessage: "Merge now or wait?" }),
      e(3, "task.turn.completed", { lastMessage: "Done: A.", reply: true }),
      e(4, "task.review"),
    ];
    const d = coalesceBacklog(entries, { now: 2000, taskState: () => "review" });
    expect(d.map((x) => x.action)).toEqual(["skip", "deliver", "deliver", "deliver"]);
  });
});

// Production race: a claude crew's turn-end arrives from the Stop hook (text) AND from
// the text-less cmux-store / native-hook lifecycle sources; whichever is first moves the
// state, and the text-carrying one must still decide delivery.
describe("claude turn-end source race (#1017)", () => {
  function setup(grace?: number) {
    const stateRoot = mkdtempSync(join(tmpdir(), "noise-"));
    const store = createStore(stateRoot);
    const { defaultNotify } = createDelivery(
      { stateRoot, store, log: () => {}, isPidAlive: () => true, opts: { captainCrewTier: () => "alert_only" } } as any,
      undefined,
    );
    const inFlight: Array<Promise<void>> = [];
    let t = 1_000_000;
    const d = createDaemon({ store, now: () => t, idleTextGraceMs: grace ?? 5000, notify: (a) => { const p = Promise.resolve(defaultNotify(a)); inFlight.push(p); return p; } });
    const ev = (e: ControlEvent) => d.handle({ kind: "event", project: "demo", event: e });
    const delivered = async () => {
      await Promise.all(inFlight);
      const out: MailboxEntry[] = [];
      for await (const e of readFromCursor({ stateRoot, project: "demo", fromSeq: 0 })) out.push(e);
      return out;
    };
    const captainSpoke = async (id: string) => { await ev({ type: "task.started", id }); t += 60_000; };
    return { store, ev, delivered, captainSpoke };
  }
  const textless = (id: string, src: string): ControlEvent => ({ type: "task.turn.completed", id, turnId: src });
  const hook = (id: string, text: string): ControlEvent => ({ type: "task.turn.completed", id, turnId: "hook-stop", lastMessage: text });
  const orders: Array<[string, (id: string, h: ControlEvent, ev: (e: ControlEvent) => Promise<unknown>) => Promise<void>]> = [
    ["text-less first, then hook", async (id, h, ev) => { await ev(textless(id, "cmux-store")); await ev(textless(id, "native-hook")); await ev(h); }],
    ["hook first, then text-less", async (id, h, ev) => { await ev(h); await ev(textless(id, "cmux-store")); await ev(textless(id, "native-hook")); }],
  ];

  for (const [name, run] of orders) {
    it(`reply to the captain: delivered word for word exactly once (${name})`, async () => {
      const { store, ev, delivered, captainSpoke } = setup();
      store.put(rec("c1"));
      await captainSpoke("c1");
      await run("c1", hook("c1", "Done: changed A and B, tests pass."), ev);
      const got = await delivered();
      expect(got).toHaveLength(1);
      expect(got[0].message).toContain("Done: changed A and B, tests pass.");
    });

    it(`plain self-resume: zero deliveries (${name})`, async () => {
      const { store, ev, delivered, captainSpoke } = setup();
      store.put(rec("c2"));
      await captainSpoke("c2");
      await run("c2", hook("c2", "Done: A."), ev);          // the reply (consumed)
      await ev({ type: "task.turn.started", id: "c2", turnId: "2" });
      const before = (await delivered()).length;
      await run("c2", hook("c2", "Also tidied B."), ev);    // self-resume, no captain message
      expect((await delivered()).length).toBe(before);
    });
  }

  it("question (hook maps it to task.blocked): delivered once with the text, text-less first", async () => {
    const { store, ev, delivered } = setup();
    store.put(rec("c3"));
    await ev(textless("c3", "cmux-store"));
    await ev({ type: "task.blocked", id: "c3", reason: "crew asked a question (auto-detected)", question: "Found 2 failures.\nFix here?" });
    await ev(textless("c3", "native-hook"));
    const got = await delivered();
    expect(got).toHaveLength(1);
    expect(got[0].message).toContain("Fix here?");
  });

  it("question: hook first, then text-less → still once", async () => {
    const { store, ev, delivered } = setup();
    store.put(rec("c4"));
    await ev({ type: "task.blocked", id: "c4", reason: "r", question: "Merge now?" });
    await ev(textless("c4", "cmux-store"));
    expect(await delivered()).toHaveLength(1);
  });

  it("hook missing, reply pending: generic CREW IDLE after the grace window, once", async () => {
    const { store, ev, delivered, captainSpoke } = setup(20);
    store.put(rec("c5"));
    await captainSpoke("c5");
    await ev(textless("c5", "cmux-store"));
    await ev(textless("c5", "native-hook"));
    expect(await delivered()).toHaveLength(0); // deferred, not yet decided
    await new Promise((r) => setTimeout(r, 80));
    const got = await delivered();
    expect(got).toHaveLength(1);
    expect(got[0].message).toMatch(/CREW IDLE.*awaiting your reply/);
  });

  it("hook missing, no reply pending (self-resume): silent", async () => {
    const { store, ev, delivered } = setup(20);
    store.put(rec("c6"));
    await ev(textless("c6", "cmux-store"));
    await new Promise((r) => setTimeout(r, 80));
    expect(await delivered()).toHaveLength(0);
  });

  it("a provider with no text source (codex) keeps the generic CREW IDLE immediately", async () => {
    const { store, ev, delivered } = setup();
    store.put(rec("c7", { provider: "codex" as any }));
    await ev(textless("c7", "codex-appserver"));
    const got = await delivered();
    expect(got).toHaveLength(1);
    expect(got[0].message).toMatch(/CREW IDLE/);
  });
});
