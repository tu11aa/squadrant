// #1010: captain compact types /compact only into an idle, clear pane, and times out cleanly.
import { describe, it, expect, vi } from "vitest";
import { createCaptainCompact, DEFAULT_COMPACT_FOCUS } from "../captain-compact.js";
import { DeferDelivery } from "../../delivery/defer-delivery.js";
import type { DaemonSurfaceDriver } from "../../interfaces.js";

const SURFACE = { workspaceId: "w", surfaceId: "s", title: "demo-captain" };
const BUSY = "✻ Cogitating… (12s · ↓ 1.2k tokens · esc to interrupt)\n╭──╮\n│ > │\n╰──╯";
const IDLE = "╭──╮\n│ > │\n╰──╯\n  ⏵⏵ accept edits on";

function harness(opts: {
  screens: string[]; send?: () => Promise<void>; timeoutMs?: number;
  undelivered?: () => number; busy?: () => boolean; holdMs?: number; onSend?: () => void;
}) {
  let t = 1000;
  const logs: string[] = [];
  const screens = [...opts.screens];
  const send = vi.fn(async () => { opts.onSend?.(); await (opts.send ?? (async () => {}))(); });
  const cmux = {
    findWorkspaceId: async () => null,
    listSurfaces: async () => [],
    readPaneScreen: async () => (screens.length > 1 ? screens.shift()! : screens[0]),
    send,
  } as unknown as DaemonSurfaceDriver;
  const c = createCaptainCompact({
    cmux, log: (l) => logs.push(l), now: () => t, timeoutMs: opts.timeoutMs ?? 600_000,
    injectedSurfaces: { demo: SURFACE }, captainTitle: () => "demo-captain",
    undeliveredCount: opts.undelivered ? async () => opts.undelivered!() : undefined,
    deliveryBusy: opts.busy, holdMs: opts.holdMs,
  });
  return { c, send, logs, advance: (ms: number) => { t += ms; } };
}

describe("captain compact", () => {
  it("never types while the captain's turn is in flight; types once idle", async () => {
    const h = harness({ screens: [BUSY, BUSY, IDLE] });
    h.c.request("demo");
    await h.c.tick(); await h.c.tick();
    expect(h.send).not.toHaveBeenCalled();
    await h.c.tick(); // idle poll 1
    expect(h.send).not.toHaveBeenCalled();
    await h.c.tick(); // idle poll 2 → send
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(SURFACE, `/compact ${DEFAULT_COMPACT_FOCUS}`, { agent: "claude" });
    expect(h.c.pendingCount()).toBe(0);
  });

  it("uses a custom focus", async () => {
    const h = harness({ screens: [IDLE] });
    h.c.request("demo", "  keep PR 7  ");
    await h.c.tick(); await h.c.tick();
    expect(h.send).toHaveBeenCalledWith(SURFACE, "/compact keep PR 7", { agent: "claude" });
  });

  it("keeps waiting when the send guard defers (open prompt / draft), then types once clear", async () => {
    let calls = 0;
    const h = harness({
      screens: [IDLE],
      send: async () => { if (++calls === 1) throw new DeferDelivery(null, "modal"); },
    });
    h.c.request("demo");
    await h.c.tick(); await h.c.tick(); // guard defers
    expect(h.c.pendingCount()).toBe(1);
    await h.c.tick(); await h.c.tick(); // idle x2 again → sent
    expect(calls).toBe(2);
    expect(h.c.pendingCount()).toBe(0);
  });

  it("times out cleanly without typing, with a log line", async () => {
    const h = harness({ screens: [BUSY], timeoutMs: 5000 });
    h.c.request("demo");
    await h.c.tick();
    h.advance(6000);
    await h.c.tick();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.c.pendingCount()).toBe(0);
    expect(h.logs.some((l) => /timed out.*turn-in-flight.*not compacted/.test(l))).toBe(true);
  });

  // #1015: compact/delivery mutex
  it("waits for the mailbox backlog to drain before typing — delivery still runs meanwhile", async () => {
    let backlog = 2;
    const h = harness({ screens: [IDLE], undelivered: () => backlog });
    h.c.request("demo");
    await h.c.tick(); await h.c.tick(); await h.c.tick();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.c.holdsDelivery("demo")).toBe(false); // draining phase must not freeze delivery
    backlog = 0;
    await h.c.tick(); await h.c.tick();
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("freezes delivery once /compact is typed, until SessionStart(compact) arrives", async () => {
    const h = harness({ screens: [IDLE], undelivered: () => 0 });
    h.c.request("demo");
    await h.c.tick(); await h.c.tick();
    expect(h.c.holdsDelivery("demo")).toBe(true);
    expect(h.c.holdsDelivery("other")).toBe(false);
    h.c.compactDone("demo");
    expect(h.c.holdsDelivery("demo")).toBe(false);
  });

  it("the hold is bounded: it lapses if SessionStart(compact) never arrives", async () => {
    const h = harness({ screens: [IDLE], undelivered: () => 0, holdMs: 5000 });
    h.c.request("demo");
    await h.c.tick(); await h.c.tick();
    expect(h.c.holdsDelivery("demo")).toBe(true);
    h.advance(6000);
    expect(h.c.holdsDelivery("demo")).toBe(false);
    expect(h.logs.some((l) => /hold lapsed/.test(l))).toBe(true);
  });

  it("race: a delivery arriving between the idle check and the send is held, not typed", async () => {
    // The mailbox reads empty at the idle check; a message lands (and a delivery pass starts)
    // before /compact is typed. The hold is already set at that moment, so the loop must skip.
    let heldAtSend: boolean | undefined;
    let holds = (_p: string) => false;
    const h = harness({
      screens: [IDLE], undelivered: () => 0,
      onSend: () => { heldAtSend = holds("demo"); },
    });
    holds = h.c.holdsDelivery;
    h.c.request("demo");
    await h.c.tick(); await h.c.tick();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(heldAtSend).toBe(true);
  });

  it("does not commit while a delivery pass is mid-flight — releases the hold and retries", async () => {
    let busy = true;
    const h = harness({ screens: [IDLE], undelivered: () => 0, busy: () => busy });
    h.c.request("demo");
    await h.c.tick(); await h.c.tick();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.c.holdsDelivery("demo")).toBe(false);
    busy = false;
    await h.c.tick(); await h.c.tick();
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("releases the hold if the send guard defers (nothing was typed)", async () => {
    const h = harness({ screens: [IDLE], undelivered: () => 0, send: async () => { throw new DeferDelivery(null, "draft"); } });
    h.c.request("demo");
    await h.c.tick(); await h.c.tick();
    expect(h.c.holdsDelivery("demo")).toBe(false);
  });
});
