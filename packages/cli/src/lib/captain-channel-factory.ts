// packages/cli/src/lib/captain-channel-factory.ts
//
// #667 slice 4: build a ClaudePeerChannel aimed at ONE project's captain.
//
// A captain is not a TaskRecord, so every lookup here is keyed by project name
// and the "taskId" argument the port passes is the project name. That is a
// deliberate reuse of the port's shape, not a mistake — captainSocketPath()
// derives the address from the project name alone.

import { createServer, connect as netConnect } from "node:net";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import { ClaudePeerChannel, ClaudeReceiptListener, writeLine, readClaudeStatusBySocketPath } from "@squadrant/agents";
import { captainSocketPath, CC_SOCKS_DIR } from "@squadrant/core";

let shared: ClaudeReceiptListener | undefined;

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
  shared = new ClaudeReceiptListener({
    socketPath: `${CC_SOCKS_DIR}/squadrantd-${process.pid}.sock`,
    createServer: (h) => createServer(h),
    // A UDS path is not cleaned up when a process is killed, so our own leftover
    // must never be the reason we refuse to start.
    unlinkStale: (p) => { try { unlinkSync(p); } catch { /* absent is the normal case */ } },
    log: (m) => console.error(chalk.dim(m)),
  });
  await shared.start();
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
