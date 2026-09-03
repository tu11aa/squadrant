// packages/cli/src/lib/captain-channel-factory.ts
//
// #667 slice 4: build a ClaudePeerChannel aimed at ONE project's captain.
//
// A captain is not a TaskRecord, so every lookup here is keyed by project name
// and the "taskId" argument the port passes is the project name. That is a
// deliberate reuse of the port's shape, not a mistake — captainSocketPath()
// derives the address from the project name alone.

import { createServer, connect as netConnect } from "node:net";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import { ClaudePeerChannel, ClaudeReceiptListener, writeLine, readClaudeStatusBySocketPath, CLAUDE_SESSIONS_DIR } from "@squadrant/agents";
import { captainSocketPath, CC_SOCKS_DIR, ensureSocksDir } from "@squadrant/core";

let shared: ClaudeReceiptListener | undefined;

/**
 * #711: register a name for the socket we just bound.
 *
 * The receiving Claude session resolves a sender's display name by looking the
 * sender's socket path up in ~/.claude/sessions/<pid>.json. We bind a socket
 * but never wrote such an entry, so every daemon-sent lifecycle message
 * (CREW DONE / BLOCKED / IDLE / TAKEOVER) rendered as anonymous "Another Claude
 * session" plus Claude's reduced-trust peer guardrail — squadrant's own signals
 * delivered under third-party framing.
 *
 * Tradeoff accepted (issue #711, direction 1): this entry makes this process
 * visible as a peer in ListAgents to every Claude session on the machine.
 * Stray traffic is inert — the receipt listener discards every frame that is
 * not a peer_message_status receipt.
 *
 * Best-effort: a write failure must degrade to the old anonymous-wrapper
 * behaviour, never block channel construction.
 */
const registryEntryPath = (): string => join(CLAUDE_SESSIONS_DIR, `${process.pid}.json`);

function unregisterSenderIdentity(): void {
  try {
    fs.unlinkSync(registryEntryPath());
  } catch {
    // absent is the normal case after a failed write or a prior clean exit
  }
}

function registerSenderIdentity(socketPath: string): void {
  try {
    // Pids get reused: a leftover file from a dead process that owned this pid
    // must never survive as "our" identity.
    unregisterSenderIdentity();
    fs.mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    // kind:"daemon" is one of Claude's own registry kinds — verified in the
    // compiled binary at ~/.local/share/claude/versions/2.1.241 (Mach-O, not an
    // npm cli.js): strings -a <binary> | grep 'interactive","bg","daemon'
    // → ["interactive","bg","daemon","daemon-worker"]. Name resolution reads
    // `name` regardless of kind, so the registry stays truthful and the
    // receiver renders `name` instead of "Another Claude session".
    // No status/statusUpdatedAt: we never refresh them, and a frozen timestamp
    // reads as a live-but-stuck session to anything trusting it.
    fs.writeFileSync(
      registryEntryPath(),
      JSON.stringify({
        pid: process.pid,
        sessionId: randomUUID(),
        name: "squadrantd",
        messagingSocketPath: socketPath,
        kind: "daemon",
        peerProtocol: 1,
      }),
    );
    // Same contract Claude itself uses for this file (process.on("exit") unlink
    // + graceful-stop unlink): a SIGKILLed writer leaves the entry behind, but
    // readers liveness-check by pid, so a dead daemon's entry is inert. A CLEAN
    // exit never leaves one — the frozen-fresh-forever class is reserved for
    // hard kills, where no handler can run.
    process.on("exit", unregisterSenderIdentity);
  } catch {
    // anonymous wrapper is the pre-#711 behaviour — acceptable degradation
  }
}

/**
 * One listener per process — it binds a socket, so constructing several would EADDRINUSE.
 *
 * The path is PID-scoped. A fixed `squadrantd.sock` was shared by the daemon and
 * every CLI invocation, so whichever started second died on EADDRINUSE — and when
 * that was the daemon, the whole control plane went down (live, 2026-08-19).
 * Receipts are routed by the `from` address we advertise, so a per-process name
 * costs nothing and removes the collision class entirely.
 */
export async function sharedReceiptListener(): Promise<ClaudeReceiptListener> {
  if (shared) return shared;
  // The daemon is usually the first process to touch CC_SOCKS_DIR after a
  // reboot clears /tmp — if it leaves the directory 755, no claude session can
  // launch afterwards (2026-09-03).
  ensureSocksDir();
  const socketPath = `${CC_SOCKS_DIR}/squadrantd-${process.pid}.sock`;
  const listener = new ClaudeReceiptListener({
    socketPath,
    createServer: (h) => createServer(h),
    // A UDS path is not cleaned up when a process is killed, so our own leftover
    // must never be the reason we refuse to start.
    unlinkStale: (p) => { try { fs.unlinkSync(p); } catch { /* absent is the normal case */ } },
    log: (m) => console.error(chalk.dim(m)),
  });
  // Cache only AFTER a successful bind (#712). Assigning `shared` before start()
  // resolves meant a transient listen failure permanently poisoned the module-level
  // singleton: every later call saw `shared` truthy and returned the never-started
  // listener without retrying the bind at all.
  await listener.start();
  registerSenderIdentity(socketPath);
  shared = listener;
  return shared;
}

/**
 * Resolve a captain's own session id from the registry entry keyed by the
 * socket path squadrant chose at launch (#709) — the same entry
 * readClaudeStatusBySocketPath already reads for statusFor. Wiring this into
 * sessionIdFor restores the pid-reuse guard and drops the "Another Claude
 * session sent a message" wrapper on the captain side. A captain that has not
 * registered yet (just booted) resolves to undefined here, same as before: no
 * session_id is sent, and the guard is skipped for that send rather than
 * throwing.
 */
export function captainSessionIdFor(taskId: string): string | undefined {
  return readClaudeStatusBySocketPath(captainSocketPath(taskId))?.sessionId;
}

export async function buildCaptainChannel(): Promise<ClaudePeerChannel> {
  const receipts = await sharedReceiptListener();
  return new ClaudePeerChannel({
    // The port's taskId IS the project name for captains.
    socketPathFor: (taskId) => captainSocketPath(taskId),
    sessionIdFor: captainSessionIdFor,
    // Captains are identified in the registry by their cwd (the project path).
    // Resolve by the socket path squadrant chose at launch, NOT by cwd: a captain
    // in /tmp/x registers cwd "/private/tmp/x" on macOS, so cwd matching silently
    // missed and every captain ping reported accepted-unconfirmed.
    statusFor: (taskId) => readClaudeStatusBySocketPath(captainSocketPath(taskId)),
    wire: (p, e) => writeLine(p, e, { connect: (path) => netConnect(path) }),
    receipts,
    newMsgId: () => randomUUID(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.error(chalk.dim(m)),
  });
}

export interface CaptainChannelRetryOpts {
  build?: () => Promise<ClaudePeerChannel>;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * #712: a bind failure at daemon boot (e.g. a transient `listen EACCES` on the
 * shared socket directory) used to be logged once and never retried, latching
 * the daemon into pane-only delivery for its entire process lifetime even
 * though the very next attempt — a manual restart — bound fine.
 *
 * Retries with capped exponential backoff FOREVER rather than giving up after
 * N tries: there is no safe bound to stop at, since giving up re-enters the
 * exact permanent degradation this fix exists to remove.
 */
export async function buildCaptainChannelWithRetry(opts: CaptainChannelRetryOpts = {}): Promise<ClaudePeerChannel> {
  const build = opts.build ?? buildCaptainChannel;
  // unref: a pending backoff timer must not hold the daemon's event loop open on shutdown.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); }));
  const log = opts.log ?? ((m: string) => console.error(chalk.dim(m)));
  const initialDelayMs = opts.initialDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 60_000;

  let delay = initialDelayMs;
  for (;;) {
    try {
      return await build();
    } catch (e) {
      log(`captain-channel init failed (retrying in ${delay}ms), pane delivery only for now: ${(e as Error).message}`);
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}
