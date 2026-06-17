// src/commands/__tests__/notify-relay.test.ts
//
// Mailbox-injector refactor: notify-relay is now a file tailer that reads
// from the per-project mailbox using a per-subscriber cursor, then forwards
// each delivered event to the captain's surface via the runtime driver.

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { appendToMailbox, writeCursor, readCursor } from "../../control/mailbox.js";
import { runNotifyRelay, DEFAULT_STATE_ROOT, STALE_THRESHOLD_MS, DEFAULT_MAX_DEFERS, DEFAULT_STABLE_PROBE_POLLS } from "../notify-relay.js";
import { DeferDelivery } from "../../runtimes/cmux.js";
import type { TaskRecord, ControlEvent } from "@cockpit/shared";

function freshState(): string {
  return mkdtempSync(join(tmpdir(), "nr-"));
}

const rec: TaskRecord = {
  id: "deadbeefcafebabe1234567890abcdef",
  project: "demo",
  provider: "claude",
  mode: "interactive",
  state: "done",
  task: "task body",
  cwd: "/",
  createdAt: 1,
  lastHeartbeat: 1,
  lastEvent: "task.done",
  heartbeatBudgetMs: 60000,
  attempts: [],
};
const doneEvent: ControlEvent = { type: "task.done", id: rec.id, resultRef: "/r" };

function fakeRuntime(sendSpy: ReturnType<typeof vi.fn>): unknown {
  return {
    sendToSurface: sendSpy,
    status: vi.fn().mockResolvedValue({ id: "ws1", name: "captain", status: "running" }),
    listSurfaces: vi.fn().mockResolvedValue([
      { workspaceId: "ws1", surfaceId: "s1", title: "captain" },
    ]),
  };
}

describe("notify-relay default stateRoot", () => {
  it("matches the daemon's default stateRoot so writer/reader agree", () => {
    // Daemon writes mailbox to <homedir>/.config/cockpit/state/inbox/<project>.log
    // (see src/control/cockpitd.ts startCockpitd). The relay's default MUST
    // resolve to the same root, otherwise no events are ever delivered.
    const daemonDefault = join(homedir(), ".config", "cockpit", "state");
    expect(DEFAULT_STATE_ROOT).toBe(daemonDefault);
  });
});

// Unified-formatter contract (#214/#210): the daemon renders the captain-facing
// message and stores it on the mailbox entry; the relay is a dumb pipe that
// delivers entry.message VERBATIM and skips entries with a null/empty message.
// These tests therefore append entries WITH a message (what defaultNotify now
// writes), not bare events.
async function append(stateRoot: string, message: string | null, event: ControlEvent = doneEvent): Promise<number> {
  return appendToMailbox({ stateRoot, project: "demo", taskRecord: rec, event, message });
}

describe("notify-relay file-tailer", () => {
  it("starts from seq 1 when cursor missing — delivers first event", async () => {
    const stateRoot = freshState();
    await append(stateRoot, "CREW DONE [claude/deadbeef]: shipped");
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][1] as string).toContain("CREW DONE");
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(1);
  });

  it("starts from seq+1 when cursor exists — delivers only newer events", async () => {
    const stateRoot = freshState();
    await append(stateRoot, "CREW DONE [claude/deadbeef]: one");
    await append(stateRoot, "CREW DONE [claude/deadbeef]: two");
    await writeCursor({ stateRoot, project: "demo", subscriber: "captain", lastAckedSeq: 1 });
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    // Only seq 2 should be delivered.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(2);
  });

  it("does NOT advance cursor when sendToSurface throws", async () => {
    const stateRoot = freshState();
    await append(stateRoot, "CREW DONE [claude/deadbeef]: x");
    const sendSpy = vi.fn().mockRejectedValue(new Error("send failed"));
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor).toBeNull(); // never written
    expect(sendSpy.mock.calls.length).toBeGreaterThan(0); // attempted
  });

  it("delivers entry.message VERBATIM (relay does not re-derive)", async () => {
    const stateRoot = freshState();
    const blockedEvent: ControlEvent = { type: "task.blocked", id: rec.id, question: "what now?" } as ControlEvent;
    const failedEvent: ControlEvent = { type: "task.failed", id: rec.id, error: "boom" } as ControlEvent;
    await append(stateRoot, "CREW DONE [claude/deadbeef]: finished", doneEvent);
    await append(stateRoot, "CREW BLOCKED [claude/deadbeef]: what now?", blockedEvent);
    await append(stateRoot, "CREW FAILED [claude/deadbeef]: boom", failedEvent);
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(sendSpy).toHaveBeenCalledTimes(3);
    const msgs = sendSpy.mock.calls.map((c) => c[1] as string);
    expect(msgs[0]).toBe("CREW DONE [claude/deadbeef]: finished");
    expect(msgs[1]).toBe("CREW BLOCKED [claude/deadbeef]: what now?");
    expect(msgs[2]).toBe("CREW FAILED [claude/deadbeef]: boom");
  });

  it("skips entries with a null/empty message but still advances the cursor", async () => {
    const stateRoot = freshState();
    await append(stateRoot, null); // daemon chose not to surface (e.g. debounced idle)
    await append(stateRoot, "   "); // whitespace-only → also skipped
    await append(stateRoot, "CREW DONE [claude/deadbeef]: real");
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    // Only the real message is delivered; the two empty entries are acked silently.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][1]).toBe("CREW DONE [claude/deadbeef]: real");
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(3);
  });

  it("logs a deliver line on successful delivery", async () => {
    const stateRoot = freshState();
    await append(stateRoot, "CREW DONE [claude/deadbeef]: shipped");
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.fn();
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
      log: logSpy,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    const lines = logSpy.mock.calls.map((c) => c[0] as string);
    expect(lines).toContainEqual(
      expect.stringMatching(/deliver seq=1 -> captain: CREW DONE \[claude\/deadbeef\]: shipped/),
    );
  });

  it("silently acks entries older than STALE_THRESHOLD_MS without forwarding to captain", async () => {
    const stateRoot = freshState();
    await append(stateRoot, "CREW DONE [claude/deadbeef]: stale");
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    // Pretend relay is booting far in the future — makes the just-written entry stale.
    const futureNow = () => Date.now() + STALE_THRESHOLD_MS + 60_000;
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
      now: futureNow,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    // Cursor must advance (so we don't replay on next start) but no notification.
    expect(sendSpy).not.toHaveBeenCalled();
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(1);
  });
});

// #258 idle-defer: relay-level defer tracking.
describe("notify-relay idle-defer (#258 phase 2)", () => {
  it("DEFAULT_MAX_DEFERS is 300 (~5min at 1s poll cadence)", () => {
    expect(DEFAULT_MAX_DEFERS).toBe(300);
  });

  it("does NOT advance cursor when sendToSurface throws DeferDelivery", async () => {
    const stateRoot = freshState();
    await append(stateRoot, "CREW DONE [claude/deadbeef]: x");
    const sendSpy = vi.fn().mockRejectedValue(new DeferDelivery());
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
    });
    // 4 polls at 50ms — deferCount=4, well below DEFAULT_MAX_DEFERS=300; cursor stays null
    await new Promise((r) => setTimeout(r, 250));
    stop();
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor).toBeNull();
    expect(sendSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("delivers and advances cursor once DeferDelivery resolves", async () => {
    const stateRoot = freshState();
    await append(stateRoot, "CREW DONE [claude/deadbeef]: x");
    // Defer once, then resolve
    let attempts = 0;
    const sendSpy = vi.fn().mockImplementation(() => {
      if (++attempts <= 1) return Promise.reject(new DeferDelivery());
      return Promise.resolve();
    });
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
    });
    await new Promise((r) => setTimeout(r, 300));
    stop();
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(1);
    expect(sendSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("probes after maxDeferDeliveries consecutive defers so message is never stuck (backstop)", async () => {
    const stateRoot = freshState();
    await append(stateRoot, "CREW DONE [claude/deadbeef]: x");
    const TEST_MAX_DEFERS = 3; // inject small value so test runs fast
    // Always defer (bare DeferDelivery = no content → never stable) unless probe=true
    const sendSpy = vi.fn().mockImplementation(
      (_surface: unknown, _msg: string, opts?: { probe?: boolean }) => {
        if (opts?.probe) return Promise.resolve();
        return Promise.reject(new DeferDelivery());
      },
    );
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
      maxDeferDeliveries: TEST_MAX_DEFERS,
    });
    // TEST_MAX_DEFERS polls + 1 probe-deliver; at 50ms each = ~200ms; allow 500ms margin
    await new Promise((r) => setTimeout(r, 500));
    stop();
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(1);
    // The call that succeeded must have had probe=true
    const probedCall = sendSpy.mock.calls.find(
      (c) => (c[2] as { probe?: boolean } | undefined)?.probe === true,
    );
    expect(probedCall).toBeDefined();
    // Total calls = TEST_MAX_DEFERS defers + 1 probe-deliver
    expect(sendSpy.mock.calls.length).toBeGreaterThanOrEqual(TEST_MAX_DEFERS + 1);
  });

  it("honors config-injected maxDeferDeliveries override", async () => {
    const stateRoot = freshState();
    await append(stateRoot, "CREW DONE [claude/deadbeef]: x");
    // With maxDeferDeliveries=1, probe should trigger after a single (no-content) defer
    const sendSpy = vi.fn().mockImplementation(
      (_surface: unknown, _msg: string, opts?: { probe?: boolean }) => {
        if (opts?.probe) return Promise.resolve();
        return Promise.reject(new DeferDelivery());
      },
    );
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 50,
      maxDeferDeliveries: 1,
    });
    await new Promise((r) => setTimeout(r, 300));
    stop();
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(1);
    expect(sendSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const probedCall = sendSpy.mock.calls.find(
      (c) => (c[2] as { probe?: boolean } | undefined)?.probe === true,
    );
    expect(probedCall).toBeDefined();
  });
});

// #302 — kill the ~5-min stall (the original #294 pain). When parseDraftFromScreen
// reports the SAME non-empty content for K consecutive polls (~a few seconds), the
// captain is NOT actively typing, so it is safe to PROBE early instead of waiting
// for the 300-defer backstop. An UNRECOGNIZED ghost stabilizes in seconds → probed →
// delivered fast. An actively-typing captain's content CHANGES → never stable → never
// probed → pure defer (no keystroke race). DeferDelivery carries the observed draft.
describe("notify-relay stability-probe (#302)", () => {
  it("DEFAULT_STABLE_PROBE_POLLS is a small value (~few seconds at 1s cadence)", () => {
    expect(DEFAULT_STABLE_PROBE_POLLS).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_STABLE_PROBE_POLLS).toBeLessThanOrEqual(10);
  });

  it("probes EARLY (before maxDefers) once content is stable for stableProbePolls consecutive polls", async () => {
    const stateRoot = freshState();
    await append(stateRoot, "CREW DONE [claude/deadbeef]: x");
    // Stable non-empty content every poll; resolve only when probe=true.
    const sendSpy = vi.fn().mockImplementation(
      (_surface: unknown, _msg: string, opts?: { probe?: boolean }) => {
        if (opts?.probe) return Promise.resolve();
        return Promise.reject(new DeferDelivery("wait for both crews to finish"));
      },
    );
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 30,
      maxDeferDeliveries: 300, // backstop far away — stability must trigger first
      stableProbePolls: 2,
    });
    await new Promise((r) => setTimeout(r, 300));
    stop();
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor?.lastAckedSeq).toBe(1);
    const probedCall = sendSpy.mock.calls.find(
      (c) => (c[2] as { probe?: boolean } | undefined)?.probe === true,
    );
    expect(probedCall, "probe must fire from stability, not the 300 backstop").toBeDefined();
    // Far fewer than 300 calls — stability triggered early
    expect(sendSpy.mock.calls.length).toBeLessThan(20);
  });

  it("never probes while content KEEPS CHANGING between polls (active typing — no keystroke race)", async () => {
    const stateRoot = freshState();
    await append(stateRoot, "CREW DONE [claude/deadbeef]: x");
    // Different content each poll → never stable → must never probe within the window.
    let n = 0;
    const sendSpy = vi.fn().mockImplementation(
      (_surface: unknown, _msg: string, opts?: { probe?: boolean }) => {
        if (opts?.probe) return Promise.resolve();
        return Promise.reject(new DeferDelivery("draft " + (n++)));
      },
    );
    const stop = await runNotifyRelay({
      project: "demo",
      subscriber: "captain",
      stateRoot,
      runtime: fakeRuntime(sendSpy) as never,
      captainName: "captain",
      pollMs: 30,
      maxDeferDeliveries: 300,
      stableProbePolls: 2,
    });
    await new Promise((r) => setTimeout(r, 300));
    stop();
    // Cursor never advanced (never delivered) and no probe ever fired.
    const cursor = await readCursor({ stateRoot, project: "demo", subscriber: "captain" });
    expect(cursor?.lastAckedSeq ?? 0).toBe(0);
    const probedCall = sendSpy.mock.calls.find(
      (c) => (c[2] as { probe?: boolean } | undefined)?.probe === true,
    );
    expect(probedCall).toBeUndefined();
  });
});
