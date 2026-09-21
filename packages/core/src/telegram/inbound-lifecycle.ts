// #838/#839: the delivery-lifecycle observable from Telegram.
//
// #838 gives the typing indicator a REAL lifecycle — ON when the message is in
// the captain's pane, OFF when the captain replies — sustained by a keep-alive
// (Telegram's chat action expires in ~5 s, so a single call carries no
// information). It also gives the operator a per-delivery trail
// (`received → delivered → typing → replied`) instead of one opaque send.
//
// #839 watches the same state: >15 min with no reply warns once and classifies
// the captain from a REAL pane read.
//
// Both read one persisted store (`state.pending`) — and the "captain replied"
// signal is literally `clearPending`. There is deliberately no second liveness
// detector: typing OFF and the watchdog disarm ARE the reply signal.
import type { TelegramClient } from "./client.js";
import { clearPending, loadPending, markPendingWarned, setPending } from "./state.js";

/** Default typing re-issue cadence. Telegram expires the action after ~5 s; 4 s
 *  keeps it continuously visible without an absurd request rate. */
export const TYPING_KEEPALIVE_MS = 4_000;
/** #839: how long the captain may stay silent before the operator is warned. */
export const WATCHDOG_MS = 15 * 60_000;
/** #839: the warn threshold is "MORE than 15 minutes" — silence at exactly 15:00
 *  is not yet a warning. */
export const WATCHDOG_GRACE_MS = 1;

/** What a pane read concluded about the captain. `unreadable` is deliberately
 *  distinct from `no-session`: a probe we could not complete must never be
 *  reported to the operator as "dead" (the #834 false-negative class). */
export type PaneReadResult =
  | { status: "locked" }
  | { status: "mid-turn" }
  | { status: "no-session" }
  | { status: "unreadable" };

export interface InboundLifecycle {
  /** Bind to the daemon poll loop — resumes/clears persisted pending state. */
  start(): void;
  /** Unbind (daemon stop) — typing stops; persisted state is left untouched. */
  stop(): void;
  /** Stage 2 done: the message is in the captain's pane. Starts the typing
   *  keep-alive and arms the watchdog, replacing any prior expectation. */
  begin(project: string, threadId: number): void;
  /** Persisted state, for tests and observability. */
  pending(): Record<string, { threadId: number; startedAt: number; warnedAt?: number }>;
}

export interface InboundLifecycleOptions {
  stateRoot: string;
  cfg: { supergroupId: number };
  /** Typing keep-alive target. */
  sendChatAction: TelegramClient["sendChatAction"];
  /** Where the `captain received` ACK and the #839 warning go. */
  sendReply: (threadId: number, text: string) => Promise<void>;
  /** REAL pane read for the #839 classification. Absent ⇒ always "unreadable". */
  readPane?: (project: string) => Promise<PaneReadResult>;
  log: (msg: string) => void;
  /** Injected clock/scheduler — production uses setTimeout; tests drive the
   *  real stored timestamps and fire timers without waiting. */
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
  typingMs?: number;
  watchdogMs?: number;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
}

/** #839 classification text. Every branch says what the operator should DO. */
export function formatWatchdogWarning(project: string, read: PaneReadResult, minutes: number): string {
  const head = `⏱️ [${project}] no reply for ${minutes} minutes`;
  switch (read.status) {
    case "locked":
      return `${head} — the captain is LOCKED on a prompt, waiting for a human. Answer it in the pane (or with \`squadrant crew answer\`) and it will continue.`;
    case "mid-turn":
      // A working captain is alive, just slow. Never cry "stuck".
      return `${head} — the captain is still working (a turn is in flight), just slow. No action needed yet.`;
    case "no-session":
      return `${head} — the captain looks GONE (no live session in its pane). Run \`squadrant launch ${project}\`.`;
    case "unreadable":
      return `${head} — couldn't read the captain's pane to classify it. Check it manually.`;
  }
}

export function createInboundLifecycle(opts: InboundLifecycleOptions): InboundLifecycle {
  const { stateRoot, cfg, sendChatAction, sendReply, readPane, log } = opts;
  const now = opts.now ?? Date.now;
  const schedule = opts.schedule ?? defaultSchedule;
  const typingMs = opts.typingMs ?? TYPING_KEEPALIVE_MS;
  const watchdogMs = opts.watchdogMs ?? WATCHDOG_MS;
  // One threshold for both the ">15 min" boundary and the "15 minutes" wording.
  const warnAtMs = watchdogMs + (opts.watchdogMs === undefined ? WATCHDOG_GRACE_MS : 0);

  // Projects with a live typing keep-alive in THIS process. The pending STORE is
  // the source of truth (it survives restarts); this set is only a guard against
  // double-scheduling two loops for the same project.
  //
  // `running` is the daemon BINDING, not a liveness signal, and deliberately
  // gates BOTH the boot resume scan and every keep-alive tick: the lifecycle is
  // inert until the daemon starts it. In production that ordering is guaranteed
  // (daemon/start.ts calls bridge.start() before the poll loop can ever read an
  // inbound, and a poll read is the only path to begin()), so a `begin()` before
  // `start()` is a caller bug, not a supported mode.
  const active = new Set<string>();
  let running = false;

  function issue(project: string, threadId: number): void {
    void Promise.resolve(sendChatAction(cfg.supergroupId, threadId, "typing")).catch((e) =>
      log(`telegram typing keep-alive failed project=${project}: ${(e as Error).message}`),
    );
  }

  function drain(project: string): void {
    active.add(project);
    const tick = () => {
      if (!running || !active.has(project)) return;
      const p = loadPending(stateRoot)[project];
      // THE reply signal: the captain replied (or the entry was otherwise
      // cleared), so the typing lifecycle is over. Stop — no second detector.
      if (!p) {
        active.delete(project);
        return;
      }
      if (now() - p.startedAt >= warnAtMs && p.warnedAt === undefined) {
        void warn(project, p.threadId);
      }
      issue(project, p.threadId);
      schedule(tick, typingMs);
    };
    schedule(tick, typingMs);
  }

  async function warn(project: string, threadId: number): Promise<void> {
    // Stamp FIRST: the warning must fire once per pending delivery, whatever
    // the pane read or the send does.
    markPendingWarned(stateRoot, project, now());
    let read: PaneReadResult = { status: "unreadable" };
    try {
      if (readPane) read = await readPane(project);
    } catch (e) {
      log(`telegram watchdog pane read failed project=${project}: ${(e as Error).message}`);
    }
    try {
      await sendReply(threadId, formatWatchdogWarning(project, read, Math.floor(watchdogMs / 60_000)));
    } catch (e) {
      log(`telegram watchdog warning failed project=${project}: ${(e as Error).message}`);
    }
  }

  return {
    start() {
      running = true;
      // Restart safety (#838 §4): never leave a phantom typing behind, and never
      // strand a live one. A pending entry whose captain is provably gone (or
      // whose message never reached it) is cleared; anything else resumes.
      for (const [project, p] of Object.entries(loadPending(stateRoot))) {
        void (async () => {
          let read: PaneReadResult = { status: "unreadable" };
          try {
            if (readPane) read = await readPane(project);
          } catch (e) {
            log(`telegram resume pane read failed project=${project}: ${(e as Error).message}`);
          }
          // Re-read: it may have been cleared while the (async) read was in flight.
          const still = loadPending(stateRoot)[project];
          if (!still || still.startedAt !== p.startedAt) return;
          if (read.status === "no-session") {
            clearPending(stateRoot, project);
            log(`telegram typing lifecycle cleared for ${project}: captain session gone on boot`);
            return;
          }
          log(`telegram typing lifecycle resumed for ${project} (thread ${p.threadId})`);
          issue(project, p.threadId);
          drain(project);
        })();
      }
    },
    stop() {
      running = false;
      active.clear();
    },
    begin(project, threadId) {
      // A (re)sent message is a NEW expectation: it replaces any prior entry
      // (so a stale warnedAt can't suppress the next warning).
      setPending(stateRoot, project, { threadId, startedAt: now() });
      issue(project, threadId);
      if (running && !active.has(project)) drain(project);
    },
    pending() {
      return loadPending(stateRoot);
    },
  };
}
