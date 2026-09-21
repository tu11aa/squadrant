import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInboundLifecycle, type PaneReadResult } from "../inbound-lifecycle.js";
import { clearPending, loadPending, setPending } from "../state.js";

const CHAT = -100;
const TYPING_MS = 60_000;
const WATCHDOG_MS = 15 * 60_000;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sq-tg-life-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A manually-driven clock — no real timer waits anywhere in this suite. */
function fakeClock(t0 = 0) {
  let now = t0;
  const timers: Array<{ fn: () => void; at: number; cancelled: boolean }> = [];
  return {
    now: () => now,
    schedule(fn: () => void, ms: number) {
      const t = { fn, at: now + ms, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    },
    /** Advance the clock, firing every due timer. */
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((t) => !t.cancelled && t.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cancelled = true;
        now = due.at;
        due.fn();
      }
      now = target;
    },
  };
}

function setup(over: Partial<Parameters<typeof createInboundLifecycle>[0]> = {}) {
  const clock = fakeClock(1_000_000);
  const sendChatAction = vi.fn(async (_chatId: number, _threadId: number | undefined, _action: string) => {});
  const sendReply = vi.fn(async (_threadId: number, _text: string) => {});
  const log = vi.fn();
  const paneRead = vi.fn(async (): Promise<PaneReadResult> => ({ status: "mid-turn" }));
  const lc = createInboundLifecycle({
    stateRoot: root,
    cfg: { supergroupId: CHAT },
    sendChatAction,
    sendReply,
    readPane: paneRead,
    log,
    now: clock.now,
    schedule: clock.schedule,
    typingMs: TYPING_MS,
    watchdogMs: WATCHDOG_MS,
    ...over,
  });
  return { lc, clock, sendChatAction, sendReply, log, paneRead };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("daemon binding contract", () => {
  it("is inert until start(): a pre-start begin() writes state but never ticks", async () => {
    // The daemon ALWAYS calls start() (daemon/start.ts) before the poll loop can
    // read an inbound — begin() is only reachable through a poll read. Gating on
    // the binding (not loosening it for tests) is the contract.
    const { lc, clock, sendChatAction, sendReply } = setup();
    lc.begin("demo", 7);
    await settle();
    // The immediate issue is intentional — it marks the moment the message
    // reached the pane. What must NOT happen is any cadence or warning: the
    // lifecycle has no timer until the daemon binds it.
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    clock.advance(TYPING_MS * 4 + WATCHDOG_MS);
    await settle();
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(sendReply).not.toHaveBeenCalled();
    expect(loadPending(root).demo).toMatchObject({ threadId: 7 });
  });

  it("ticks once started", async () => {
    const { lc, clock, sendChatAction } = setup();
    lc.start();
    lc.begin("demo", 7);
    await settle();
    clock.advance(TYPING_MS);
    await settle();
    expect(sendChatAction.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("typing lifecycle (#838)", () => {
  it("keep-alives the typing action until the captain replies", async () => {
    const { lc, clock, sendChatAction } = setup();
    lc.start();

    lc.begin("demo", 7);
    await settle();
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(sendChatAction).toHaveBeenLastCalledWith(CHAT, 7, "typing");

    clock.advance(TYPING_MS);
    await settle();
    expect(sendChatAction).toHaveBeenCalledTimes(2);
    expect(loadPending(root).demo).toMatchObject({ threadId: 7 });

    clock.advance(TYPING_MS);
    await settle();
    expect(sendChatAction).toHaveBeenCalledTimes(3);
  });

  it("stops the keep-alive when the captain replies (the shared signal)", async () => {
    const { lc, clock, sendChatAction } = setup();
    lc.start();
    lc.begin("demo", 7);
    await settle();

    clearPending(root, "demo"); // the single captain-replied signal
    clock.advance(TYPING_MS * 3);
    await settle();

    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(loadPending(root).demo).toBeUndefined();
  });

  it("re-arms on a new inbound for the same project (threadId refreshed)", async () => {
    const { lc, clock, sendChatAction } = setup();
    lc.start();
    lc.begin("demo", 7);
    await settle();

    clock.advance(TYPING_MS);
    await settle();
    lc.begin("demo", 8);
    await settle();

    expect(loadPending(root).demo).toMatchObject({ threadId: 8 });
    expect(sendChatAction).toHaveBeenLastCalledWith(CHAT, 8, "typing");
  });

  it("swallows a failing typing call without killing the keep-alive", async () => {
    const sendChatAction = vi.fn(async () => { throw new Error("429 flood control"); });
    const { lc, clock } = setup({ sendChatAction });

    lc.start();
    lc.begin("demo", 7);
    await settle();
    expect(sendChatAction).toHaveBeenCalledTimes(1);

    clock.advance(TYPING_MS);
    await settle();
    expect(sendChatAction).toHaveBeenCalledTimes(2);
  });
});

describe("restart safety (#838 §4)", () => {
  it("resumes the keep-alive for a pending delivery that survived on disk", async () => {
    setPending(root, "demo", { threadId: 7, startedAt: 1_000_000 - 60_000 });
    const { lc, sendChatAction } = setup();

    lc.start(); // daemon boot
    await settle();

    expect(sendChatAction).toHaveBeenCalledWith(CHAT, 7, "typing");
    expect(loadPending(root).demo).toMatchObject({ threadId: 7 });
  });

  it("clears a stranded pending entry and never sends a phantom typing", async () => {
    setPending(root, "demo", { threadId: 7, startedAt: 1_000_000 });
    const { lc, sendChatAction } = setup({ readPane: async () => ({ status: "no-session" }) });

    lc.start();
    await settle();

    expect(sendChatAction).not.toHaveBeenCalled();
    expect(loadPending(root).demo).toBeUndefined();
  });

  it("does not drop a pending entry when the pane cannot be read (fail-safe)", async () => {
    setPending(root, "demo", { threadId: 7, startedAt: 1_000_000 });
    const { lc, sendChatAction } = setup({ readPane: async () => ({ status: "unreadable" }) });

    lc.start();
    await settle();

    expect(sendChatAction).toHaveBeenCalledWith(CHAT, 7, "typing");
    expect(loadPending(root).demo).toMatchObject({ threadId: 7 });
  });

  it("stops the keep-alive on shutdown", async () => {
    setPending(root, "demo", { threadId: 7, startedAt: 1_000_000 });
    const { lc, clock, sendChatAction } = setup();
    lc.start();
    await settle();

    lc.stop();
    clock.advance(TYPING_MS * 5);
    await settle();

    expect(sendChatAction).toHaveBeenCalledTimes(1);
  });
});

describe("unresponsive-captain watchdog (#839)", () => {
  const warnText = (t: string) => t.includes("15 minutes");

  it("warns exactly once after >15 min and never nags", async () => {
    const { lc, clock, sendReply } = setup();
    lc.start();
    lc.begin("demo", 7);
    await settle();

    // The injected clock pins the exact boundary (the production grace exists
    // only because real ticks are every 4s, so a live warn lands at 15:00–15:04
    // and the "15 minutes" wording stays honest).
    clock.advance(WATCHDOG_MS - 1);
    await settle();
    expect(sendReply).not.toHaveBeenCalled();

    clock.advance(1);
    await settle();
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(warnText(sendReply.mock.calls[0][1] as string)).toBe(true);

    clock.advance(WATCHDOG_MS * 3);
    await settle();
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(loadPending(root).demo?.warnedAt).toBe(1_000_000 + WATCHDOG_MS);
  });

  it("says the captain is LOCKED on a prompt when the pane shows one", async () => {
    const { lc, clock, sendReply } = setup({ readPane: async () => ({ status: "locked" }) });
    lc.start();
    lc.begin("demo", 7);
    clock.advance(WATCHDOG_MS + 1);
    await settle();

    const text = sendReply.mock.calls[0][1] as string;
    expect(text).toContain("LOCKED");
    expect(text).toContain("waiting for a human");
  });

  it("says the captain is working (not stuck) when it is mid-turn", async () => {
    const { lc, clock, sendReply } = setup({ readPane: async () => ({ status: "mid-turn" }) });
    lc.start();
    lc.begin("demo", 7);
    clock.advance(WATCHDOG_MS + 1);
    await settle();

    const text = sendReply.mock.calls[0][1] as string;
    expect(text).toContain("working");
    expect(text).not.toContain("LOCKED");
  });

  it("admits it could not classify an unreadable pane instead of crying stuck", async () => {
    // A probe we could not complete must never be reported as "dead" — the
    // #834 false-negative class. It also must not claim the captain is working.
    const { lc, clock, sendReply } = setup({ readPane: async () => ({ status: "unreadable" }) });
    lc.start();
    lc.begin("demo", 7);
    clock.advance(WATCHDOG_MS + 1);
    await settle();

    const text = sendReply.mock.calls[0][1] as string;
    expect(text).toContain("couldn't read");
    expect(text).not.toContain("LOCKED");
    expect(text).not.toContain("GONE");
  });

  it("does not warn when the captain replied before the deadline", async () => {
    const { lc, clock, sendReply } = setup();
    lc.start();
    lc.begin("demo", 7);
    clock.advance(WATCHDOG_MS - 1);
    await settle();

    clearPending(root, "demo");
    clock.advance(WATCHDOG_MS * 2);
    await settle();

    expect(sendReply).not.toHaveBeenCalled();
  });

  it("is disarmed on restart for a stranded pending entry (no phantom warning)", async () => {
    setPending(root, "demo", { threadId: 7, startedAt: 1_000_000 - WATCHDOG_MS * 2 });
    const { lc, clock, sendReply } = setup({ readPane: async () => ({ status: "no-session" }) });

    lc.start();
    clock.advance(WATCHDOG_MS * 3);
    await settle();

    expect(sendReply).not.toHaveBeenCalled();
    expect(loadPending(root).demo).toBeUndefined();
  });

  it("swallows a failing warning send without killing the loop", async () => {
    const sendReply = vi.fn(async () => { throw new Error("network down"); });
    const { lc, clock, sendChatAction } = setup({ sendReply });
    lc.start();
    lc.begin("demo", 7);
    clock.advance(WATCHDOG_MS + 1);
    await settle();
    expect(sendReply).toHaveBeenCalledTimes(1);

    clock.advance(TYPING_MS);
    await settle();
    expect(sendChatAction.mock.calls.length).toBeGreaterThan(1);
  });
});
