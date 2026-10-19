// #1010: captain compact types /compact only into an idle, clear pane, and times out cleanly.
import { describe, it, expect, vi } from "vitest";
import { createCaptainCompact, DEFAULT_COMPACT_FOCUS } from "../captain-compact.js";
import { DeferDelivery } from "../../delivery/defer-delivery.js";
import type { DaemonSurfaceDriver } from "../../interfaces.js";

const SURFACE = { workspaceId: "w", surfaceId: "s", title: "demo-captain" };
const BUSY = "✻ Cogitating… (12s · ↓ 1.2k tokens · esc to interrupt)\n╭──╮\n│ > │\n╰──╯";
const IDLE = "╭──╮\n│ > │\n╰──╯\n  ⏵⏵ accept edits on";

function harness(opts: { screens: string[]; send?: () => Promise<void>; timeoutMs?: number }) {
  let t = 1000;
  const logs: string[] = [];
  const screens = [...opts.screens];
  const send = vi.fn(opts.send ?? (async () => {}));
  const cmux = {
    findWorkspaceId: async () => null,
    listSurfaces: async () => [],
    readPaneScreen: async () => (screens.length > 1 ? screens.shift()! : screens[0]),
    send,
  } as unknown as DaemonSurfaceDriver;
  const c = createCaptainCompact({
    cmux, log: (l) => logs.push(l), now: () => t, timeoutMs: opts.timeoutMs ?? 600_000,
    injectedSurfaces: { demo: SURFACE }, captainTitle: () => "demo-captain",
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
});
