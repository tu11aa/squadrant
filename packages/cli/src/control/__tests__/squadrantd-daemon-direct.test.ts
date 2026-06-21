import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSquadrantd, discoverCaptainSurface } from "../squadrantd.js";
import { appendToMailbox, writeCursor, readCursor } from "@squadrant/core";
import { STALE_THRESHOLD_MS } from "@squadrant/core";
import { sendRequest } from "@squadrant/core";
import { crewPaneTitle } from "@squadrant/core";
import type { DaemonCmux } from "@squadrant/workspaces";
import type { PaneRef } from "@squadrant/shared";
import type { TaskRecord, ControlEvent } from "@squadrant/shared";

const TASK: TaskRecord = {
  id: "t1", project: "p", provider: "claude", mode: "interactive",
  state: "submitted", task: "x", createdAt: 1, lastHeartbeat: 1,
  lastEvent: "", heartbeatBudgetMs: 1000,
  name: "test-crew",
  attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
};

const EVENT: ControlEvent = { type: "task.done", id: "t1", resultRef: "/tmp/x" };

function fakeCmux(): DaemonCmux & { sent: Array<{ text: string }> } {
  const sent: Array<{ text: string }> = [];
  return {
    sent,
    send: async (_surface: PaneRef, text: string) => { sent.push({ text }); },
    listSurfaces: async () => [],
    readScreen: async () => null,
    isAvailable: async () => true,
    findWorkspaceId: async () => null, // cmux workspaces not available in test
  } as unknown as DaemonCmux & { sent: Array<{ text: string }> };
}

// A claude permission dialog (box-drawing chrome included) — classifyPaneTail
// recognises this as an approval wait. Copied from notify-relay-probe.test.ts.
const APPROVAL_TAIL = [
  "● I'll create the file now.",
  "╭──────────────────────────────────────────────────────╮",
  "│ Do you want to create newfile.txt?                     │",
  "│ ❯ 1. Yes                                               │",
  "│   2. No, and tell Claude what to do differently        │",
  "╰──────────────────────────────────────────────────────╯",
  "  accept edits on (shift+tab to cycle)                    ",
].join("\n");

describe("squadrantd daemon-direct (#332)", () => {
  let stop: (() => void) | undefined;
  let dir: string;
  afterEach(() => { stop?.(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("daemon delivers queued captain messages via DaemonCmux + CaptainDelivery", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-dd-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    mkdirSync(join(stateRoot, "inbox"), { recursive: true });

    // Seed the mailbox directly.
    await appendToMailbox({ stateRoot, project: "p", taskRecord: TASK, event: EVENT, message: "CREW DONE [claude/t1] — build the widget" });
    // Write cursor for the "captain" subscriber starting at seq 0.
    await writeCursor({ stateRoot, project: "p", subscriber: "captain", lastAckedSeq: 0 });

    const cmux = fakeCmux();
    const handle = startSquadrantd({
      stateRoot,
      sockPath: sock,
      sweepMs: 0,
      daemonCmux: cmux,

      captainSurfaces: { p: { workspaceId: "ws:1", surfaceId: "surface:1", title: "captain" } },
    });
    stop = handle.stop;

    if (handle.tickDelivery) await handle.tickDelivery();

    expect(cmux.sent.length).toBe(1);
    expect(cmux.sent[0].text).toMatch(/CREW DONE/);
  });

  // BUG 3 (#332 storm): the daemon-direct delivery loop lacked the relay's
  // STALE_THRESHOLD_MS silent-ack, so a fresh/empty cursor re-delivered the
  // entire historical backlog (the same CREW DONE events fired dozens of times).
  // Entries older than sessionStart - STALE_THRESHOLD_MS must be silently acked
  // (cursor advanced) WITHOUT being delivered.
  it("daemon silently acks stale backlog entries without delivering them", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-dd-stale-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    const inbox = join(stateRoot, "inbox");
    mkdirSync(inbox, { recursive: true });

    // Seed two STALE entries (older than STALE_THRESHOLD_MS) followed by one
    // FRESH entry, all written directly so we control the timestamps.
    const staleTs = new Date(Date.now() - STALE_THRESHOLD_MS - 60_000).toISOString();
    const freshTs = new Date().toISOString();
    const line = (seq: number, ts: string, message: string) =>
      JSON.stringify({ seq, ts, taskId: "t1", name: "test-crew", kind: "task.done", provider: "claude", payload: {}, message }) + "\n";
    appendFileSync(join(inbox, "p.log"),
      line(1, staleTs, "CREW DONE stale-1") +
      line(2, staleTs, "CREW DONE stale-2") +
      line(3, freshTs, "CREW DONE fresh-3"),
      "utf-8");
    await writeCursor({ stateRoot, project: "p", subscriber: "captain", lastAckedSeq: 0 });

    const cmux = fakeCmux();
    const handle = startSquadrantd({
      stateRoot,
      sockPath: sock,
      sweepMs: 0,
      daemonCmux: cmux,

      captainSurfaces: { p: { workspaceId: "ws:1", surfaceId: "surface:1", title: "captain" } },
    });
    stop = handle.stop;

    if (handle.tickDelivery) await handle.tickDelivery();

    // Only the fresh entry is delivered; the two stale ones are skipped.
    expect(cmux.sent.length).toBe(1);
    expect(cmux.sent[0].text).toMatch(/fresh-3/);
    // The cursor advanced past all three (stale ones silently acked).
    const c = await readCursor({ stateRoot, project: "p", subscriber: "captain" });
    expect(c?.lastAckedSeq).toBe(3);
  });

  it("discoverCaptainSurface finds the matching captain pane by title", () => {
    const surfaces: PaneRef[] = [
      { workspaceId: "ws:1", surfaceId: "s9", title: "⚓ squadrant-captain" },
      { workspaceId: "ws:1", surfaceId: "s10", title: "🔧 squadrant:crew-1" },
    ];
    expect(discoverCaptainSurface(surfaces, "⚓ squadrant-captain")?.surfaceId).toBe("s9");
    expect(discoverCaptainSurface(surfaces, "nonexistent")).toBeNull();
  });

  it("reaps the captain as closed after K consecutive sweeps with no captain surface", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-dd-reap-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    mkdirSync(join(stateRoot, "inbox"), { recursive: true });

    // Seed first message (delivered on tick 1). A second message is appended
    // after the reap (before tick 5) to prove delivery resumes.
    await appendToMailbox({ stateRoot, project: "p", taskRecord: TASK, event: EVENT, message: "CREW DONE #1" });
    await writeCursor({ stateRoot, project: "p", subscriber: "captain", lastAckedSeq: 0 });
    mkdirSync(join(stateRoot, "p"), { recursive: true });
    writeFileSync(join(stateRoot, "p", `${TASK.id}.json`), JSON.stringify(TASK));

    const captainTitle = "p-captain";
    let surfCall = 0;
    // Index 0 is consumed by d.reconcile() on boot (checks surface liveness).
    // Then tick 1 uses index 1, tick 2 uses index 2, etc.
    const surfResults: PaneRef[][] = [
      [{ workspaceId: "ws:1", surfaceId: "s0", title: captainTitle }],     // reconcile (boot): found
      [{ workspaceId: "ws:1", surfaceId: "s1", title: captainTitle }],    // tick 1: found → deliver #1
      [{ workspaceId: "ws:1", surfaceId: "s2", title: "some-other-pane" }], // tick 2: gone
      [{ workspaceId: "ws:1", surfaceId: "s2", title: "some-other-pane" }], // tick 3: gone
      [{ workspaceId: "ws:1", surfaceId: "s2", title: "some-other-pane" }], // tick 4: gone → reap
      [{ workspaceId: "ws:1", surfaceId: "s1", title: captainTitle }],      // tick 5: un-reap + deliver #2
    ];
    const cmux = {
      sent: [] as Array<{ text: string }>,
      send: async (_surface: PaneRef, text: string) => { (cmux as any).sent.push({ text }); },
      listSurfaces: async () => surfResults[surfCall++],
      readScreen: async () => null,
      isAvailable: async () => true,
      findWorkspaceId: async (name: string) => name === captainTitle ? "ws:1" : null,
    } as unknown as DaemonCmux & { sent: Array<{ text: string }> };

    const handle = startSquadrantd({
      stateRoot, sockPath: sock, sweepMs: 0,
      daemonCmux: cmux,

    });
    stop = handle.stop;

    // Tick 1: captain found → message delivered.
    if (handle.tickDelivery) await handle.tickDelivery();
    expect(cmux.sent.length).toBe(1);

    // Tick 2-4: captain gone → streak builds to K=3 → project reaped.
    if (handle.tickDelivery) await handle.tickDelivery(); // streak=1
    expect(cmux.sent.length).toBe(1);
    if (handle.tickDelivery) await handle.tickDelivery(); // streak=2
    expect(cmux.sent.length).toBe(1);
    if (handle.tickDelivery) await handle.tickDelivery(); // streak=3 → reaped
    expect(cmux.sent.length).toBe(1);

    // Append a second message to prove delivery resumes.
    await appendToMailbox({ stateRoot, project: "p", taskRecord: TASK, event: EVENT, message: "CREW DONE #2" });
    if (handle.tickDelivery) await handle.tickDelivery(); // tick 5: deliver #2
    expect(cmux.sent.length).toBe(2);
  });

  it("reap is NON-terminal: resume on reappearance, re-enter after K on fresh cycle", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-dd-reap2-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    mkdirSync(join(stateRoot, "inbox"), { recursive: true });

    // Seed first message (delivered on tick 1). Second message appended after
    // reap (before tick 5) to prove delivery resumes.
    await appendToMailbox({ stateRoot, project: "p", taskRecord: TASK, event: EVENT, message: "CREW DONE #1" });
    await writeCursor({ stateRoot, project: "p", subscriber: "captain", lastAckedSeq: 0 });
    mkdirSync(join(stateRoot, "p"), { recursive: true });
    writeFileSync(join(stateRoot, "p", `${TASK.id}.json`), JSON.stringify(TASK));

    const captainTitle = "p-captain";
    let surfCall = 0;
    // Index 0 is consumed by d.reconcile() on boot. Then tick 1 uses index 1, etc.
    const surfResults: PaneRef[][] = [
      [{ workspaceId: "ws:1", surfaceId: "s0", title: captainTitle }],     // reconcile (boot): found
      [{ workspaceId: "ws:1", surfaceId: "s1", title: captainTitle }],    // tick 1: found → deliver
      [{ workspaceId: "ws:1", surfaceId: "s2", title: "other" }],          // tick 2: gone    streak=1
      [{ workspaceId: "ws:1", surfaceId: "s2", title: "other" }],          // tick 3: gone    streak=2
      [{ workspaceId: "ws:1", surfaceId: "s2", title: "other" }],          // tick 4: gone    streak=3 → reap fires (once)
      [{ workspaceId: "ws:1", surfaceId: "s1", title: captainTitle }],    // tick 5: found   → un-reap + deliver
      [{ workspaceId: "ws:1", surfaceId: "s2", title: "other" }],          // tick 6: gone    streak=1 (fresh cycle)
      [{ workspaceId: "ws:1", surfaceId: "s2", title: "other" }],          // tick 7: gone    streak=2
      [{ workspaceId: "ws:1", surfaceId: "s2", title: "other" }],          // tick 8: gone    streak=3 → reap fires again
    ];
    const cmux = {
      sent: [] as Array<{ text: string }>,
      send: async (_surface: PaneRef, text: string) => { (cmux as any).sent.push({ text }); },
      listSurfaces: async () => surfResults[surfCall++],
      readScreen: async () => null,
      isAvailable: async () => true,
      findWorkspaceId: async (name: string) => name === captainTitle ? "ws:1" : null,
    } as unknown as DaemonCmux & { sent: Array<{ text: string }> };

    const handle = startSquadrantd({
      stateRoot, sockPath: sock, sweepMs: 0,
      daemonCmux: cmux,

    });
    stop = handle.stop;

    // Phase 1: present → absent → reap.
    if (handle.tickDelivery) await handle.tickDelivery(); // tick 1: deliver
    expect(cmux.sent.length).toBe(1);
    if (handle.tickDelivery) await handle.tickDelivery(); // tick 2: streak=1
    expect(cmux.sent.length).toBe(1);
    if (handle.tickDelivery) await handle.tickDelivery(); // tick 3: streak=2
    expect(cmux.sent.length).toBe(1);
    if (handle.tickDelivery) await handle.tickDelivery(); // tick 4: streak=3 → reap
    expect(cmux.sent.length).toBe(1);

    // Phase 2: append second message, then reappear → resume delivery.
    await appendToMailbox({ stateRoot, project: "p", taskRecord: TASK, event: EVENT, message: "CREW DONE #2" });
    if (handle.tickDelivery) await handle.tickDelivery(); // tick 5: deliver #2
    expect(cmux.sent.length).toBe(2);

    // Phase 3: absent again → fresh streak → reap again.
    if (handle.tickDelivery) await handle.tickDelivery(); // tick 6: streak=1
    expect(cmux.sent.length).toBe(2);
    if (handle.tickDelivery) await handle.tickDelivery(); // tick 7: streak=2
    expect(cmux.sent.length).toBe(2);
    if (handle.tickDelivery) await handle.tickDelivery(); // tick 8: streak=3 → reap again
    expect(cmux.sent.length).toBe(2);
    // If tick 9 had captain found, delivery would resume to 3.
  });

  it("reaps the stopped project's orphaned interactive crews to 'cancelled' (captain-stopped)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-dd-orphan-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    mkdirSync(join(stateRoot, "inbox"), { recursive: true });

    // A live interactive crew running in the captain's workspace.
    const crew: TaskRecord = {
      id: "orphan-1", project: "p", provider: "claude", mode: "interactive",
      state: "working", task: "build", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "task.started", heartbeatBudgetMs: 1000,
      name: "orphan",
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
    };
    await appendToMailbox({ stateRoot, project: "p", taskRecord: crew, event: EVENT, message: "CREW DONE #1" });
    await writeCursor({ stateRoot, project: "p", subscriber: "captain", lastAckedSeq: 0 });
    mkdirSync(join(stateRoot, "p"), { recursive: true });
    writeFileSync(join(stateRoot, "p", `${crew.id}.json`), JSON.stringify(crew));

    const captainTitle = "p-captain";
    const crewPane = crewPaneTitle("p", "orphan");
    let surfCall = 0;
    // Index 0 is consumed by boot d.reconcile() (probes the crew's own pane —
    // keep BOTH panes present so the crew survives reconcile and is reaped only
    // by the captain-stopped path). Then tick N uses index N.
    const surfResults: PaneRef[][] = [
      [{ workspaceId: "ws:1", surfaceId: "s0", title: captainTitle }, { workspaceId: "ws:1", surfaceId: "sc", title: crewPane }], // reconcile: captain+crew present
      [{ workspaceId: "ws:1", surfaceId: "s1", title: captainTitle }, { workspaceId: "ws:1", surfaceId: "sc", title: crewPane }], // tick 1: found → deliver
      [{ workspaceId: "ws:1", surfaceId: "s2", title: "other" }], // tick 2: gone, streak=1
      [{ workspaceId: "ws:1", surfaceId: "s2", title: "other" }], // tick 3: gone, streak=2
      [{ workspaceId: "ws:1", surfaceId: "s2", title: "other" }], // tick 4: gone, streak=3 → reap crews + stop
    ];
    const cmux = {
      sent: [] as Array<{ text: string }>,
      send: async (_surface: PaneRef, text: string) => { (cmux as any).sent.push({ text }); },
      listSurfaces: async () => surfResults[Math.min(surfCall++, surfResults.length - 1)],
      readScreen: async () => null,
      isAvailable: async () => true,
      findWorkspaceId: async (name: string) => name === captainTitle ? "ws:1" : null,
    } as unknown as DaemonCmux & { sent: Array<{ text: string }> };

    const handle = startSquadrantd({ stateRoot, sockPath: sock, sweepMs: 0, daemonCmux: cmux });
    stop = handle.stop;

    // Let boot reconcile settle (consumes index 0) before the manual ticks.
    await new Promise((r) => setTimeout(r, 20));

    // Crew is still live (working) before the captain goes away.
    const before = await sendRequest(sock, { kind: "status", project: "p", id: "orphan-1" }) as TaskRecord;
    expect(before.state).toBe("working");

    if (handle.tickDelivery) await handle.tickDelivery(); // tick 1: captain found → deliver
    if (handle.tickDelivery) await handle.tickDelivery(); // tick 2: streak=1
    if (handle.tickDelivery) await handle.tickDelivery(); // tick 3: streak=2
    if (handle.tickDelivery) await handle.tickDelivery(); // tick 4: streak=3 → reap

    // The orphaned crew is reaped to a terminal state with the captain-stopped marker.
    const after = await sendRequest(sock, { kind: "status", project: "p", id: "orphan-1" }) as TaskRecord;
    expect(after.state).toBe("cancelled");
    expect(after.lastEvent).toBe("captain-stopped");
  });

  it("does NOT reap on a single transient empty sweep (K>1)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-dd-transient-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    mkdirSync(join(stateRoot, "inbox"), { recursive: true });

    await appendToMailbox({ stateRoot, project: "p", taskRecord: TASK, event: EVENT, message: "CREW DONE [claude/t1]" });
    await writeCursor({ stateRoot, project: "p", subscriber: "captain", lastAckedSeq: 0 });
    mkdirSync(join(stateRoot, "p"), { recursive: true });
    writeFileSync(join(stateRoot, "p", `${TASK.id}.json`), JSON.stringify(TASK));

    // Mock: reconcile consumes index 0, then tick 1 uses index 1, tick 2 uses index 2
    let callIdx = 0;
    const results: PaneRef[][] = [
      [{ workspaceId: "ws:1", surfaceId: "s0", title: "p-captain" }],      // reconcile (boot): found
      [{ workspaceId: "ws:1", surfaceId: "s2", title: "some-other-pane" }], // tick 1: gone
      [{ workspaceId: "ws:1", surfaceId: "s1", title: "p-captain" }],       // tick 2: found
    ];
    const captainTitle = "p-captain";
    const cmux = {
      sent: [] as Array<{ text: string }>,
      send: async (_surface: PaneRef, text: string) => { (cmux as any).sent.push({ text }); },
      listSurfaces: async () => results[callIdx++],
      readScreen: async () => null,
      isAvailable: async () => true,
      findWorkspaceId: async (name: string) => name === captainTitle ? "ws:1" : null,
    } as unknown as DaemonCmux & { sent: Array<{ text: string }> };

    const handle = startSquadrantd({
      stateRoot, sockPath: sock, sweepMs: 0,
      daemonCmux: cmux,

    });
    stop = handle.stop;

    // Tick 1: transient absence → streak=1, no delivery.
    if (handle.tickDelivery) await handle.tickDelivery();
    expect(cmux.sent.length).toBe(0);

    // Tick 2: captain found → message delivered, streak reset.
    if (handle.tickDelivery) await handle.tickDelivery();
    expect(cmux.sent.length).toBe(1);
  });

  it("without injected daemonCmux: constructs DaemonCmux via makeDaemonCmux and wires delivery (prod path)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-dd-prod-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    mkdirSync(join(stateRoot, "inbox"), { recursive: true });

    await appendToMailbox({ stateRoot, project: "p", taskRecord: TASK, event: EVENT, message: "CREW DONE [claude/t1]" });
    await writeCursor({ stateRoot, project: "p", subscriber: "captain", lastAckedSeq: 0 });

    const sent: Array<{ text: string }> = [];
    const handle = startSquadrantd({
      stateRoot,
      sockPath: sock,
      sweepMs: 0,

      makeDaemonCmux: () => ({
        send: async (_surface: PaneRef, text: string) => { sent.push({ text }); },
        listSurfaces: async () => [],
        readScreen: async () => null,
        isAvailable: async () => true,
        findWorkspaceId: async () => null,
      } as unknown as DaemonCmux),
      captainSurfaces: { p: { workspaceId: "ws:1", surfaceId: "surface:1", title: "captain" } },
    });
    stop = handle.stop;

    expect(handle.tickDelivery).toBeDefined();
    if (handle.tickDelivery) await handle.tickDelivery();
    expect(sent.length).toBe(1);
    expect(sent[0].text).toMatch(/CREW DONE/);
  });

  // #332 storm BUG (re-entrancy): each deliveryTick does multiple slow cmux
  // subprocess calls and can exceed the 1s interval. Without a re-entrancy guard,
  // the interval fires again while the previous tick is still mid-flight; both
  // ticks read the SAME cursor seq and both deliver the entries after it →
  // duplicate/storm delivery. The guard must skip an overlapping tick so every
  // mailbox entry is delivered EXACTLY ONCE even when ticks overlap.
  it("overlapping delivery ticks deliver each entry exactly once (re-entrancy guard)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-dd-reentrancy-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    mkdirSync(join(stateRoot, "inbox"), { recursive: true });

    // One fresh mailbox entry. Both ticks would (without a guard) read cursor=0
    // and deliver this same seq.
    await appendToMailbox({ stateRoot, project: "p", taskRecord: TASK, event: EVENT, message: "CREW DONE [claude/t1] — only once" });
    await writeCursor({ stateRoot, project: "p", subscriber: "captain", lastAckedSeq: 0 });

    // A send that blocks on a controllable gate, so tick #1 is still in-flight
    // (cursor not yet advanced) when we fire tick #2.
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const sent: Array<{ text: string }> = [];
    const cmux = {
      sent,
      send: async (_surface: PaneRef, text: string) => { sent.push({ text }); await sendGate; },
      listSurfaces: async () => [],
      readScreen: async () => null,
      isAvailable: async () => true,
      findWorkspaceId: async () => null,
    } as unknown as DaemonCmux & { sent: Array<{ text: string }> };

    const handle = startSquadrantd({
      stateRoot, sockPath: sock, sweepMs: 0,
      daemonCmux: cmux,

      captainSurfaces: { p: { workspaceId: "ws:1", surfaceId: "surface:1", title: "captain" } },
    });
    stop = handle.stop;

    // Fire tick #1 (does not resolve — blocked inside send awaiting the gate).
    const tick1 = handle.tickDelivery!();
    // Let tick #1 reach the blocked send.
    await new Promise((r) => setTimeout(r, 10));
    // Fire tick #2 while tick #1 is still in-flight → guard must skip it.
    await handle.tickDelivery!();
    // tick #2 returned immediately (skipped); only tick #1's send is pending.
    expect(sent.length).toBe(1);

    // Release the gate and let tick #1 finish + advance the cursor.
    releaseSend();
    await tick1;

    // Exactly one delivery total, cursor advanced once.
    expect(sent.length).toBe(1);
    const c = await readCursor({ stateRoot, project: "p", subscriber: "captain" });
    expect(c?.lastAckedSeq).toBe(1);

    // A subsequent (non-overlapping) tick must NOT re-deliver the already-acked entry.
    await handle.tickDelivery!();
    expect(sent.length).toBe(1);
  });

  it("daemon-direct probe emits task.blocked when interactive crew pane shows a permission prompt", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-dd-probe-"));
    const sock = join(dir, "c.sock");
    const stateRoot = join(dir, "state");
    mkdirSync(join(stateRoot, "inbox"), { recursive: true });

    // Seed a working interactive task that is quiet enough to be probed.
    const worker: TaskRecord = {
      id: "probe-1", project: "p", provider: "claude", mode: "interactive",
      state: "working", task: "x", createdAt: 1, lastHeartbeat: 1,
      lastEvent: "", heartbeatBudgetMs: 1000,
      name: "worker",
      attempts: [{ attemptId: "a0", startedAt: 1, lastHeartbeatAt: 1 }],
    };

    const cmux = {
      sent: [] as Array<{ text: string }>,
      send: async () => {},
      listSurfaces: async () => [
        { workspaceId: "ws:1", surfaceId: "s1", title: crewPaneTitle("p", "worker") },
      ],
      readScreen: async () => APPROVAL_TAIL,
      readPaneScreen: async () => APPROVAL_TAIL,
      isAvailable: async () => true,
      findWorkspaceId: async () => "ws:1",
    } as unknown as DaemonCmux & { sent: Array<{ text: string }> };

    const handle = startSquadrantd({
      stateRoot, sockPath: sock, sweepMs: 0,
      daemonCmux: cmux,

    });
    stop = handle.stop;

    // Seed the task into the daemon's store.
    await sendRequest(sock, { kind: "seed", record: worker });

    // Wait for boot reconcile to settle, then trigger the probe tick.
    await new Promise((r) => setTimeout(r, 20));
    if ((handle as any).tickProbe) await (handle as any).tickProbe();

    // Verify task transitioned to blocked. lastEvent is "task.blocked"
    // (the event type); reason is protocol/logging-only per state-machine.ts.
    const updated = await sendRequest(sock, { kind: "status", project: "p", id: "probe-1" }) as TaskRecord;
    expect(updated.state).toBe("blocked");
  });
});
