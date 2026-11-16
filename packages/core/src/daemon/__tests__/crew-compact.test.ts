// #1051: crew compact types /compact only into an idle crew pane, holds `crew send` meanwhile, and refuses what it cannot compact.
import { describe, it, expect, vi } from "vitest";
import type { TaskRecord } from "@squadrant/shared";
import { createCrewCompact } from "../crew-compact.js";
import { reduce } from "../../state-machine.js";
import { DeferDelivery, SubmitUnconfirmed } from "../../delivery/defer-delivery.js";
import type { DaemonSurfaceDriver } from "../../interfaces.js";

const SURFACE = { workspaceId: "w", surfaceId: "s", title: "🔧 demo:crew-1" };
const BUSY = "✻ Cogitating… (12s · ↓ 1.2k tokens · esc to interrupt)\n╭──╮\n│ > │\n╰──╯";
const IDLE = "╭──╮\n│ > │\n╰──╯\n  ⏵⏵ accept edits on";

const rec = (o: Partial<TaskRecord> = {}): TaskRecord =>
  ({ id: "t1", project: "demo", name: "crew-1", provider: "claude", state: "awaiting-input", createdAt: 1, ...o }) as TaskRecord;

function harness(o: { task?: Partial<TaskRecord>; screens?: string[]; send?: () => Promise<void>; holdMs?: number; surface?: boolean; hangSurface?: boolean; notify?: (p: string, t: string) => void } = {}) {
  let t = 1000;
  const logs: string[] = [];
  const task = rec({ attempts: [], ...o.task });
  const screens = [...(o.screens ?? [IDLE])];
  const send = vi.fn(async () => { await (o.send ?? (async () => {}))(); });
  const cmux = {
    findWorkspaceId: o.hangSurface ? () => new Promise<null>(() => {}) : async () => null,
    listSurfaces: async () => [],
    readPaneScreen: async () => (screens.length > 1 ? screens.shift()! : screens[0]),
    send,
  } as unknown as DaemonSurfaceDriver;
  // #1089: endTurn runs the real reducer over the shared record, as the daemon's ingest does.
  const c = createCrewCompact({
    cmux, log: (l) => logs.push(l), now: () => t, holdMs: o.holdMs, notify: o.notify,
    endTurn: (_p, id) => { Object.assign(task, reduce(task, { type: "task.turn.completed", id, turnId: "compact" }, t)); },
    tasks: () => [task], captainTitle: () => "demo-captain",
    injectedSurfaces: o.surface === false ? {} : { "demo:crew-1": SURFACE },
  });
  return { c, send, logs, task, advance: (ms: number) => { t += ms; } };
}

describe("crew compact", () => {
  it("queues, waits while the crew is mid-turn, types once idle, then holds until SessionStart(compact)", async () => {
    const h = harness({ screens: [BUSY, IDLE] });
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false);
    await expect(h.c.request("demo", "crew-1", "  keep PR 7 ")).resolves.toEqual({ queued: true, agent: "claude", joined: false });
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(true); // queued ⇒ sends already wait
    await h.c.tick();
    expect(h.send).not.toHaveBeenCalled();
    await h.c.tick(); // idle poll 1
    await h.c.tick(); // idle poll 2 → send
    expect(h.send).toHaveBeenCalledWith(SURFACE, "/compact keep PR 7", { agent: "claude" });
    expect(h.c.pendingCount()).toBe(0);
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(true); // typed, compact still running
    h.c.compactDone("t1");
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false); // sends resume, after the compact
  });

  it("types /compact exactly once when the next interval tick fires while the send is still in flight", async () => {
    const releases: Array<() => void> = [];
    const h = harness({ send: () => new Promise<void>((r) => { releases.push(r); }) });
    await h.c.request("demo", "crew-1");
    await h.c.tick(); // idle poll 1
    const first = h.c.tick(); // idle poll 2 → send starts, still awaiting
    await new Promise((r) => setTimeout(r, 0));
    const second = h.c.tick(); // next interval fires mid-send
    await new Promise((r) => setTimeout(r, 0));
    releases.forEach((r) => r());
    await Promise.all([first, second]);
    await h.c.tick();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.logs.filter((l) => l.endsWith("/compact sent"))).toHaveLength(1);
  });

  it("does not type while the task is working, even with an idle-looking pane", async () => {
    const h = harness({ task: { state: "working" } });
    await h.c.request("demo", "crew-1");
    await h.c.tick(); await h.c.tick(); await h.c.tick();
    expect(h.send).not.toHaveBeenCalled();
    h.task.state = "awaiting-input";
    await h.c.tick(); await h.c.tick();
    expect(h.send).toHaveBeenCalledWith(SURFACE, "/compact", { agent: "claude" });
  });

  it("compacts an already-idle crew whose task is done and carries a stale pendingTool", async () => {
    const h = harness({ task: { state: "done", pendingTool: { name: "mcp__squadrant__crew_signal_done", since: 1 } } });
    await h.c.request("demo", "crew-1", "smoke");
    await h.c.tick(); await h.c.tick();
    expect(h.send).toHaveBeenCalledWith(SURFACE, "/compact smoke", { agent: "claude" });
  });

  it("still waits on a live task's open tool, and says why", async () => {
    const h = harness({ task: { state: "awaiting-input", pendingTool: { name: "Bash", since: 1 } } });
    await h.c.request("demo", "crew-1");
    await h.c.tick(); await h.c.tick();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.logs.some((l) => l.includes("still waiting (tool-open)"))).toBe(true);
  });

  it("waits through an open tool call and a send-guard deferral, then types", async () => {
    let calls = 0;
    const h = harness({ send: async () => { if (++calls === 1) throw new DeferDelivery(null, "draft"); } });
    h.task.pendingTool = { name: "Bash", since: 1 };
    await h.c.request("demo", "crew-1");
    await h.c.tick(); await h.c.tick();
    expect(h.send).not.toHaveBeenCalled();
    h.task.pendingTool = undefined;
    await h.c.tick(); await h.c.tick(); // deferred
    expect(h.c.pendingCount()).toBe(1);
    await h.c.tick(); await h.c.tick();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.c.pendingCount()).toBe(0);
  });

  it("says why it is waiting when the send guard keeps deferring (no-box), once a minute", async () => {
    const h = harness({ send: async () => { throw new DeferDelivery(null, "no-box"); } });
    await h.c.request("demo", "crew-1");
    await h.c.tick(); await h.c.tick(); // idle ×2 → send → deferred
    expect(h.logs.filter((l) => l.includes("still waiting (no-box)"))).toHaveLength(1);
    await h.c.tick(); await h.c.tick(); // same minute → no second line
    expect(h.logs.filter((l) => l.includes("still waiting (no-box)"))).toHaveLength(1);
    h.advance(61_000);
    await h.c.tick(); await h.c.tick();
    expect(h.logs.filter((l) => l.includes("still waiting (no-box)"))).toHaveLength(2);
  });

  it("#1087: an unconfirmed submit is not reported sent — stays pending, logged", async () => {
    const h = harness({ send: async () => { throw new SubmitUnconfirmed(); } });
    await h.c.request("demo", "crew-1");
    await h.c.tick(); await h.c.tick(); // idle ×2 → typed, Enter never confirmed
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.c.pendingCount()).toBe(1);
    expect(h.logs.some((l) => l.includes("submit unconfirmed"))).toBe(true);
    expect(h.logs.some((l) => l.includes("/compact sent"))).toBe(false);
  });

  it("cancel drops a queued compact and its send hold, and is a no-op when nothing is queued", async () => {
    const h = harness({ task: { state: "awaiting-input" }, screens: [BUSY] });
    expect(h.c.cancel("demo", "crew-1")).toEqual({ cancelled: false });
    await h.c.request("demo", "crew-1");
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(true);
    expect(h.c.cancel("demo", "crew-1")).toEqual({ cancelled: true });
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false);
    expect(h.c.pendingCount()).toBe(0);
    expect(h.logs.filter((l) => l.includes("cancelled"))).toHaveLength(1);
    await h.c.tick();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("cancel also releases the hold of a compact already typed", async () => {
    const h = harness();
    await h.c.request("demo", "crew-1");
    await h.c.tick(); await h.c.tick();
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(true);
    expect(h.c.cancel("demo", "crew-1")).toEqual({ cancelled: true });
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false);
  });

  it("opencode crews are typed with the opencode grammar and judged by task state, not the Claude spinner", async () => {
    const h = harness({ task: { provider: "opencode" }, screens: [BUSY] });
    await h.c.request("demo", "crew-1");
    await h.c.tick(); await h.c.tick();
    expect(h.send).toHaveBeenCalledWith(SURFACE, "/compact", { agent: "opencode" });
  });

  it("the hold lapses on its own if no SessionStart(compact) arrives", async () => {
    const h = harness({ holdMs: 5000 });
    await h.c.request("demo", "crew-1");
    await h.c.tick(); await h.c.tick();
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(true);
    h.advance(6000);
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false);
    expect(h.logs.some((l) => l.includes("hold lapsed"))).toBe(true);
  });

  it("refuses a crew under operator takeover, at request time", async () => {
    const h = harness({ task: { operatorHold: { since: 1 } } });
    await expect(h.c.request("demo", "crew-1")).rejects.toThrow(/operator takeover/);
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false);
  });

  it("drops a queued compact when the operator takes over before it runs", async () => {
    const h = harness({ task: { state: "working" } });
    await h.c.request("demo", "crew-1");
    h.task.operatorHold = { since: 2 };
    await h.c.tick();
    expect(h.c.pendingCount()).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("refuses gemini and codex crews, unknown crews, ended crews and crews without a pane", async () => {
    await expect(harness({ task: { provider: "gemini" } }).c.request("demo", "crew-1")).rejects.toThrow(/gemini.*fresh crew/);
    await expect(harness({ task: { provider: "codex" } }).c.request("demo", "crew-1")).rejects.toThrow(/codex.*fresh crew/);
    await expect(harness().c.request("demo", "nope")).rejects.toThrow(/not found/);
    await expect(harness({ task: { state: "cancelled" } }).c.request("demo", "crew-1")).rejects.toThrow(/ended/);
    await expect(harness({ surface: false }).c.request("demo", "crew-1")).rejects.toThrow(/no live pane/);
  });

  // #1125: the old 600s cap silently dropped a compact queued for a crew still mid-turn.
  it("keeps waiting for a working crew within the 10-minute cap, then types once idle", async () => {
    const h = harness({ task: { state: "working" } });
    await h.c.request("demo", "crew-1");
    h.advance(9 * 60_000);
    await h.c.tick();
    expect(h.c.pendingCount()).toBe(1);
    expect(h.logs.some((l) => l.includes("timed out"))).toBe(false);
    h.task.state = "awaiting-input";
    await h.c.tick();
    await h.c.tick();
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  // #1133: a queued compact must never deadlock a blocked crew's answer.
  it("does not hold sends while the crew is busy (blocked/working), holds once it is idle", async () => {
    const h = harness({ task: { state: "blocked" } });
    await h.c.request("demo", "crew-1");
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false);
    h.task.state = "working";
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false);
    h.task.state = "awaiting-input";
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(true);
    await h.c.tick();
    await h.c.tick(); // typed
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(true); // typed ⇒ the hold map keeps it
  });

  it("drops after the queue cap, releases the hold and tells the captain once", async () => {
    const notices: string[] = [];
    const h = harness({ task: { state: "working" }, notify: (_p, t) => { notices.push(t); } });
    await h.c.request("demo", "crew-1");
    h.advance(11 * 60_000);
    await h.c.tick();
    await h.c.tick();
    expect(h.c.pendingCount()).toBe(0);
    expect(h.c.holdsCrew("demo", "crew-1")).toBe(false);
    expect(h.logs.some((l) => l.includes("timed out"))).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/CREW COMPACT DROPPED \[demo:crew-1\].*NOT compacted/);
  });

  it("collapses a repeat request into the pending one and lets a new --keep replace the old", async () => {
    const h = harness({ screens: [IDLE] });
    await expect(h.c.request("demo", "crew-1", "old")).resolves.toMatchObject({ joined: false });
    await expect(h.c.request("demo", "crew-1")).resolves.toMatchObject({ joined: true });
    await expect(h.c.request("demo", "crew-1", "new")).resolves.toMatchObject({ joined: true });
    expect(h.c.pendingCount()).toBe(1);
    expect(h.logs.filter((l) => l.endsWith("waiting for idle crew") || l.includes("queued, waiting"))).toHaveLength(1);
    await h.c.tick();
    await h.c.tick();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(SURFACE, "/compact new", { agent: "claude" });
  });

  it("acks a request even when the pane lookup hangs (the caller must not time out)", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ hangSurface: true });
      const p = h.c.request("demo", "crew-1");
      await vi.advanceTimersByTimeAsync(3100);
      await expect(p).resolves.toMatchObject({ queued: true });
      expect(h.c.pendingCount()).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  // #1087: an Enter that never confirms is retried, then reported — never logged as sent.
  it("drops with a captain notice after repeated unconfirmed submits, never logging 'sent'", async () => {
    const notices: string[] = [];
    const h = harness({ send: async () => { throw new SubmitUnconfirmed(); }, notify: (_p, t) => { notices.push(t); } });
    await h.c.request("demo", "crew-1");
    for (let i = 0; i < 12; i++) await h.c.tick();
    expect(h.c.pendingCount()).toBe(0);
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(h.logs.some((l) => l.endsWith("/compact sent"))).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/Enter never confirmed/);
  });

  // #1089: no Stop follows a compact, so SessionStart(compact) closes the turn (after a PreCompact(manual)).
  it("a compact returns the crew to idle, and a second compact types again", async () => {
    const h = harness();
    for (let round = 0; round < 2; round++) {
      await h.c.request("demo", "crew-1");
      await h.c.tick();
      await h.c.tick();
      expect(h.send).toHaveBeenCalledTimes(round + 1);
      h.c.compactBegin("demo", "t1");        // PreCompact(manual)
      h.task.state = "working";               // the other lifecycle sources leave it working
      h.c.compactDone("t1");                  // SessionStart(compact)
      expect(h.task.state).toBe("awaiting-input");
    }
  });

  it("a hand-typed compact (no daemon request) also returns the crew to idle", () => {
    const h = harness({ task: { state: "working" } });
    h.c.compactBegin("demo", "t1");
    h.c.compactDone("t1");
    expect(h.task.state).toBe("awaiting-input");
  });

  it("a compact with no /compact prompt (auto-compact in a live turn) leaves the task working", () => {
    const h = harness({ task: { state: "working" } });
    h.c.compactDone("t1");
    expect(h.task.state).toBe("working");
  });

  it("a compact that never reaches SessionStart does not mark a later auto-compact", () => {
    const h = harness({ task: { state: "working" } });
    h.c.compactBegin("demo", "t1");
    h.advance(11 * 60_000);
    h.c.compactDone("t1");
    expect(h.task.state).toBe("working");
  });

  it("a crew already idle is left alone (no synthetic turn-end to consume a pending reply)", () => {
    const h = harness();
    h.c.compactBegin("demo", "t1");
    h.c.compactDone("t1");
    expect(h.task.state).toBe("awaiting-input");
  });

  it("a blocked crew stays blocked through a compact", () => {
    const h = harness({ task: { state: "blocked" } });
    h.c.compactBegin("demo", "t1");
    h.c.compactDone("t1");
    expect(h.task.state).toBe("blocked");
  });
});
