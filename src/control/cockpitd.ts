// src/control/cockpitd.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn as realSpawn } from "node:child_process";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createStore } from "./store.js";
import { createDaemon } from "./daemon.js";
import { startServer, encodeFrame, type AttachFrame, type AttachInbound } from "./protocol.js";
import { runHeadless } from "./headless-launcher.js";
import { CodexInteractiveDriver } from "./codex/driver.js";
import { makeGate } from "./codex/gate.js";
import { appendToMailbox, rotateIfNeeded } from "./mailbox.js";
import { readdir } from "node:fs/promises";
import type { Gate, TaskRecord, ControlEvent } from "./types.js";
import type { Socket } from "node:net";

export interface CockpitdOpts {
  stateRoot?: string;
  sockPath?: string;
  sweepMs?: number; // 0 disables the interval (tests)
  isPidAlive?: (pid: number) => boolean; // injectable for the headless reconcile path (tests)
  spawn?: typeof realSpawn;
  /**
   * Push-notification hook (#109). Defaults to shelling out to
   * `cockpit runtime send <project> <message>` (which already does the
   * project→captain workspace lookup via NotifierRegistry + config).
   * Tests inject a fake to assert call shape without spawning.
   */
  notify?: (args: {
    project: string;
    message: string;
    record: TaskRecord;
    event: ControlEvent;
  }) => Promise<void> | void;
  /** Background rotation timer interval (ms). 0 disables. Default 60_000. */
  rotationIntervalMs?: number;
  /** Mailbox rotation thresholds (size/age/retention). */
  mailboxConfig?: {
    maxBytes?: number;
    maxAgeMs?: number;
    keepCount?: number;
  };
  /** Inject a fake driver for tests. Defaults to a real CodexInteractiveDriver. */
  codexDriver?: import("./codex/driver.js").CodexInteractiveDriver | {
    dispatch: (rec: any) => Promise<void>;
    reattach: (rec: any) => Promise<void>;
    say: (taskId: string, text: string) => Promise<void>;
    steer: (taskId: string, text: string) => Promise<void>;
    interrupt: (taskId: string) => Promise<void>;
    answer: (taskId: string, payload: unknown) => Promise<void>;
  };
}

export function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === "EPERM"; } // EPERM = alive but not ours; ESRCH = dead
}

export function startCockpitd(opts: CockpitdOpts = {}) {
  const stateRoot = opts.stateRoot ?? join(homedir(), ".config", "cockpit", "state");
  const sockPath = opts.sockPath ?? join(homedir(), ".config", "cockpit", "cockpit.sock");
  const store = createStore(stateRoot);
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const spawn = opts.spawn ?? realSpawn;
  const resultsDir = join(stateRoot, "_results");
  mkdirSync(resultsDir, { recursive: true });
  const writeResult = (id: string, payload: string) => {
    const p = join(resultsDir, `${id}.txt`);
    writeFileSync(p, payload);
    return p;
  };
  // Minimal lifecycle logging (red-team #2: the log was a timestampless wall
  // of crash stacks with no "started" marker).
  const log = (m: string) => process.stderr.write(`[cockpitd] ${new Date().toISOString()} ${m}\n`);

  // ── Attach fan-out (spec §4.5/§4.6) ──────────────────────────────────────
  // Per-task set of live attach connections. Populated in onAttach, cleaned up
  // in onAttachClose. Not exposed outside this closure.
  const attachConns = new Map<string, Set<Socket>>();

  // ── Notify subscribers (#111) ────────────────────────────────────────────
  // Per-project set of live subscribe-notify connections. The daemon cannot
  // shell out to `cmux send` directly because cmux refuses any caller not
  // descended from its app process; instead it pushes frames here and an
  // in-cmux relay tab (cockpit notify-relay) forwards to the captain pane.
  const notifySubs = new Map<string, Set<Socket>>();
  const inboxDir = join(stateRoot, "..", "inbox");
  mkdirSync(inboxDir, { recursive: true });
  function pushNotify(project: string, message: string): void {
    const ts = Date.now();
    // Durable record (debug/inspection) — even if no subscriber is live, the
    // file persists what would have been delivered.
    try {
      const line = `${new Date(ts).toISOString()}\t${message.replace(/\n/g, " ")}\n`;
      appendFileSync(join(inboxDir, `${project}.log`), line);
    } catch (e) {
      log(`inbox append failed project=${project}: ${(e as Error).message}`);
    }
    // Live broadcast to any subscribed relay.
    const conns = notifySubs.get(project);
    if (!conns || conns.size === 0) return;
    const wire = encodeFrame({ type: "push", project, message, ts });
    for (const conn of conns) {
      try { conn.write(wire); } catch { /* relay vanished; close handler will clean up */ }
    }
  }

  function broadcast(taskId: string, f: AttachFrame): void {
    const conns = attachConns.get(taskId);
    if (!conns) return;
    const wire = encodeFrame(f);
    for (const conn of conns) {
      try { conn.write(wire); } catch { /* client gone; onAttachClose will clean up */ }
    }
  }

  // ── Gate promotion (spec §4.9) ────────────────────────────────────────────
  // When a server-request event fires and no client is attached, start a 5s
  // timer. If still unattached at fire time, promote to a Gate in the store
  // and broadcast gate-promoted so any later-attaching client can offer takeover.
  const pendingGateTimers = new Map<string, { taskId: string; timer: NodeJS.Timeout }>();

  function schedulePromotion(
    taskId: string,
    requestId: number,
    kind: "input" | "approval",
    question: string,
  ): void {
    // If a client is already attached for this task, no promotion needed.
    const conns = attachConns.get(taskId);
    if (conns && conns.size > 0) return;
    const key = `${taskId}#${requestId}`;
    // Clear any prior timer for the same (taskId, requestId).
    const prior = pendingGateTimers.get(key);
    if (prior) clearTimeout(prior.timer);
    const timer = setTimeout(() => {
      pendingGateTimers.delete(key);
      // Re-check at fire time — a client may have attached in the 5s window.
      if (attachConns.get(taskId)?.size) return;
      const rec = store.listAll().find((r) => r.id === taskId);
      if (!rec) return;
      const gate: Gate = makeGate({ taskId, kind, question, now: Date.now(), mkId: () => randomUUID() });
      const gates = [...(rec.gates ?? []), gate];
      store.put({ ...rec, gates });
      broadcast(taskId, { type: "gate-promoted", taskId, gateId: gate.gateId });
      log(`gate promoted gateId=${gate.gateId} taskId=${taskId} kind=${kind}`);
    }, 5_000);
    timer.unref?.();
    pendingGateTimers.set(key, { taskId, timer });
  }

  function cancelPromotionsFor(taskId: string): void {
    for (const [key, slot] of pendingGateTimers.entries()) {
      if (slot.taskId === taskId) {
        clearTimeout(slot.timer);
        pendingGateTimers.delete(key);
      }
    }
  }

  // ── CodexInteractiveDriver singleton ─────────────────────────────────────
  // The driver holds the single AppServerClient child. Each task maps to a
  // thread inside that child. Events emitted here (a) update the state-machine
  // via daemon.handle and (b) broadcast streaming AttachFrames to cmux clients.
  const codexDriver = opts.codexDriver ?? new CodexInteractiveDriver({
    emit: (ev) => {
      // Resolve the project so we can call daemon.handle with {kind:"event"}.
      // store.listAll() is O(tasks) but tasks are few; acceptable for events.
      const found = store.listAll().find((r) => r.id === ev.id);
      if (!found) return;
      void d.handle({ kind: "event", project: found.project, event: ev });

      // Map ControlEvent → AttachFrame and broadcast to any attached cmux clients.
      if (ev.type === "task.delta")
        broadcast(ev.id, { type: "delta", taskId: ev.id, text: ev.chunk });
      else if (ev.type === "task.turn.started")
        broadcast(ev.id, { type: "turn-started", taskId: ev.id });
      else if (ev.type === "task.turn.completed")
        broadcast(ev.id, { type: "turn-completed", taskId: ev.id });
      else if (ev.type === "task.input.requested") {
        broadcast(ev.id, { type: "input-requested", taskId: ev.id, requestId: ev.requestId, question: ev.question });
        schedulePromotion(ev.id, ev.requestId, "input", ev.question);
      } else if (ev.type === "task.approval.requested") {
        broadcast(ev.id, { type: "approval-requested", taskId: ev.id, requestId: ev.requestId, question: ev.question, kind: ev.kind });
        schedulePromotion(ev.id, ev.requestId, "approval", ev.question);
      }
      else if (ev.type === "task.reattached")
        broadcast(ev.id, { type: "reattached", taskId: ev.id });
    },
  });

  const ingest = (project: string) => (e: import("./types.js").ControlEvent) =>
    void d.handle({ kind: "event", project, event: e });

  // Default push-notification wiring (mailbox-injector spec): the daemon
  // appends a JSON entry to <stateRoot>/inbox/<project>.log. An injector
  // process running inside the captain workspace tails the file from its
  // cursor and delivers each entry to the captain pane. The daemon never
  // shells out to cmux; the captain owns delivery. Tests inject a fake
  // `notify` to assert call shape without exercising the mailbox path.
  const defaultNotify = async (args: {
    project: string;
    message: string;
    record: TaskRecord;
    event: ControlEvent;
  }): Promise<void> => {
    try {
      await appendToMailbox({
        stateRoot,
        project: args.project,
        taskRecord: args.record,
        event: args.event,
      });
    } catch (e) {
      log(`mailbox append failed project=${args.project}: ${(e as Error).message}`);
    }
    // Legacy push-frame broadcast preserved for PR #112's relay tab during the
    // bridge state. Removed in Task 8 once the file-tailer injector replaces it.
    pushNotify(args.project, args.message);
  };
  const notify = opts.notify ?? defaultNotify;

  const d = createDaemon({
    store, now: () => Date.now(), isPidAlive, notify,
    launchHeadless: async (rec) => {
      await runHeadless({
        provider: rec.provider, task: rec.task, id: rec.id, sessionId: rec.sessionId,
        cwd: rec.cwd, spawn, emit: ingest(rec.project), writeResult,
      });
    },
    launchInteractive: async (rec) => {
      if (rec.provider === "codex") {
        await codexDriver.dispatch(rec as any);
        return;
      }
      if (rec.provider === "claude") {
        // Claude interactive crews run in a cmux tab — the daemon does NOT
        // own a Claude process. The tab does the actual launch. The daemon's
        // only role for Claude is the state ledger: emit task.started so the
        // record transitions submitted → working, then wait for task.progress
        // / task.done events from the injected hook bridge + explicit
        // `cockpit crew signal` (see claude-interactive spec, §4.4).
        ingest(rec.project)({ type: "task.started", id: rec.id });
        return;
      }
      throw new Error(
        `interactive mode is not yet implemented for provider '${rec.provider}'; only 'codex' and 'claude' are supported`,
      );
    },
    resolveInteractiveGate: async (taskId, payload) => {
      try { await codexDriver.answer(taskId, payload); }
      catch (e) { log(`gate-resolve answer failed: ${(e as Error).message}`); }
    },
  });

  d.reconcile(); // crash recovery on boot

  // Restart-reattach (spec §5; closes interactive slice of #86):
  // For each non-terminal interactive-codex task that has a resumeRef, fire
  // reattach() against the driver. Fire-and-forget; failures are logged only.
  for (const rec of store.listAll()) {
    if (rec.provider !== "codex" || rec.mode !== "interactive") continue;
    if (rec.state === "done" || rec.state === "failed") continue;
    const ref = rec.attempts.at(-1)?.resumeRef;
    if (!ref) continue;
    codexDriver.reattach(rec).catch((e: unknown) => {
      log(`reattach failed for ${rec.id}: ${(e as Error).message}`);
    });
  }

  const server = startServer(sockPath, {
    handler: async (msg: any) => {
      if (msg.kind === "seed") { store.put(msg.record as TaskRecord); return { ok: true }; }
      return d.handle(msg);
    },
    onAttach: (conn, frame) => {
      let set = attachConns.get(frame.taskId);
      if (!set) { set = new Set(); attachConns.set(frame.taskId, set); }
      set.add(conn);
      // A client arriving within the 5s window defuses any pending gate timer.
      cancelPromotionsFor(frame.taskId);
      // Immediately ack the attach so the client knows it's live.
      try { conn.write(encodeFrame({ type: "reattached", taskId: frame.taskId })); } catch { /* ignore */ }
    },
    onAttachInbound: (_conn, frame) => {
      // A second 'attach' on an already-claimed conn is ignored by protocol.ts,
      // so every frame here is a genuine inbound op.
      const f = frame as AttachInbound;
      if (f.op === "say")
        void codexDriver.say(f.taskId, f.text).catch((e: unknown) => log(`say err: ${e}`));
      else if (f.op === "steer")
        void codexDriver.steer(f.taskId, f.text).catch((e: unknown) => log(`steer err: ${e}`));
      else if (f.op === "interrupt")
        void codexDriver.interrupt(f.taskId).catch((e: unknown) => log(`interrupt err: ${e}`));
      else if (f.op === "answer")
        void codexDriver.answer(f.taskId, f.payload).catch((e: unknown) => log(`answer err: ${e}`));
    },
    onAttachClose: (conn) => {
      // Remove the conn from every task's set (the conn only exists in one set,
      // but a linear scan over a small map is fine).
      for (const set of attachConns.values()) set.delete(conn);
    },
    onSubscribeNotify: (conn, frame) => {
      let set = notifySubs.get(frame.project);
      if (!set) { set = new Set(); notifySubs.set(frame.project, set); }
      set.add(conn);
      log(`notify subscribed project=${frame.project}`);
    },
    onSubscribeNotifyClose: (conn) => {
      for (const set of notifySubs.values()) set.delete(conn);
    },
  });
  log(`started pid=${process.pid} sock=${sockPath} stateRoot=${stateRoot}`);

  let timer: NodeJS.Timeout | undefined;
  if (opts.sweepMs && opts.sweepMs > 0) {
    timer = setInterval(() => d.sweep(), opts.sweepMs);
    timer.unref?.();
  }

  const rotationInterval = opts.rotationIntervalMs ?? 60_000;
  const mboxCfg = {
    maxBytes: opts.mailboxConfig?.maxBytes ?? 5 * 1024 * 1024,
    maxAgeMs: opts.mailboxConfig?.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000,
    keepCount: opts.mailboxConfig?.keepCount ?? 3,
  };
  let rotationTimer: NodeJS.Timeout | undefined;
  if (rotationInterval > 0) {
    const inboxPath = join(stateRoot, "inbox");
    rotationTimer = setInterval(async () => {
      try {
        let entries: string[];
        try { entries = await readdir(inboxPath); }
        catch { return; }
        const projects = new Set(
          entries
            .filter((e) => e.endsWith(".log"))
            .map((e) => e.slice(0, -".log".length)),
        );
        for (const project of projects) {
          await rotateIfNeeded({ stateRoot, project, ...mboxCfg });
        }
      } catch (e) {
        log(`rotation timer error: ${(e as Error).message}`);
      }
    }, rotationInterval);
    rotationTimer.unref?.();
  }

  return {
    stop() {
      if (timer) clearInterval(timer);
      if (rotationTimer) clearInterval(rotationTimer);
      server.close();
      log("stopped");
    },
  };
}

// Executed by launchd (ProgramArguments → this file's compiled .js).
if (process.argv[1] && process.argv[1].endsWith("cockpitd.js")) {
  const h = startCockpitd({ sweepMs: 30000 });
  process.on("SIGTERM", () => { h.stop(); process.exit(0); });
}
