// src/commands/crew-attach.ts
import { Command } from "commander";
import chalk from "chalk";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { decodeFrames, type AttachFrame, type AttachInbound } from "@cockpit/core";

function socketPath(): string {
  return process.env.COCKPITD_SOCK ?? join(homedir(), ".config", "cockpit", "cockpit.sock");
}

// --- Pure formatters (exported for tests) ---

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function rule(width: number, ch = "─"): string {
  return ch.repeat(Math.max(0, width));
}

export function formatTurnHeader(turn: number, width = 60): string {
  const label = ` codex · turn ${turn} `;
  const remaining = Math.max(2, width - label.length - 2);
  const left = "╭─";
  const right = rule(remaining) + "╮";
  return chalk.cyan.bold(left) + chalk.cyan.bold(label) + chalk.cyan(right);
}

export function formatTurnFooter(elapsedMs: number, width = 60): string {
  const secs = (elapsedMs / 1000).toFixed(1);
  const label = ` done · ${secs}s `;
  const remaining = Math.max(2, width - label.length - 2);
  const left = "╰─";
  const right = rule(remaining) + "╯";
  return chalk.dim(left + label + right);
}

export type RendererState = "idle" | "working" | "awaiting-input" | "blocked";

export function formatStatus(state: RendererState, turn: number, elapsedMs: number): string {
  const secs = (elapsedMs / 1000).toFixed(1);
  return chalk.dim(`  · state=${state}  turn=${turn}  elapsed=${secs}s`);
}

export function formatApproval(kind: string, question: string): string {
  return chalk.yellow.bold(`[approval] ${kind}`) + chalk.yellow(`: ${question}`);
}

export function formatApprovalPrompt(): string {
  return chalk.yellow("[approve/deny]> ");
}

export function formatInputQuestion(question: string): string {
  return chalk.cyan.bold("[codex asks] ") + question;
}

export function formatInputPrompt(): string {
  return chalk.cyan("[answer]> ");
}

export function formatDoneFollowup(): string {
  return chalk.dim("[done — type a follow-up or Ctrl-C]");
}

export function formatAttached(): string {
  return chalk.dim("(attached)");
}

export function formatReattached(): string {
  return chalk.dim("(reattached)");
}

export function formatClosed(reason: string): string {
  return chalk.dim(`(closed: ${reason})`);
}

export function formatConnectionClosed(): string {
  return chalk.dim("(connection closed)");
}

export function formatConnectionLost(): string {
  return chalk.dim("(connection lost — retrying...)");
}

export function formatReattachFailed(taskId: string): string {
  return chalk.red(`(reattach failed — re-run: cockpit crew attach ${taskId})`);
}

export function formatGatePromoted(gateId: string): string {
  return chalk.dim(`(no client was attached; question promoted to gate ${gateId})`);
}

// --- Retry/backoff pure logic (exported for tests) ---

/** Minimum elapsed ms on a connection before it's considered stable (no-frame path). */
export const STABLE_MS = 5_000;

/** Total retry budget per disconnect episode before giving up. */
export const RETRY_BUDGET_MS = 60_000;

/**
 * Exponential backoff delay for reconnect attempt N (0-indexed).
 * Caps at 16s to bound the per-attempt wait.
 */
export function computeBackoffDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 16_000);
}

/**
 * Returns true if the connection should be considered "stable" —
 * meaning backoff should reset on the next disconnect.
 * Stable = received >=1 real frame OR survived >= STABLE_MS.
 */
export function isConnectionStable(
  connectTimeMs: number,
  framesReceived: number,
  nowMs: number
): boolean {
  return connectTimeMs > 0 && (framesReceived > 0 || nowMs - connectTimeMs >= STABLE_MS);
}

// --- CLI command ---

export const crewAttachCommand = new Command("attach")
  .description("Attach to a live interactive task (renders deltas; takes follow-ups). Spec §4.6.")
  .argument("<taskId>", "task id to attach to")
  .action((taskId: string) => {
    // --- Retry state (persists across reconnects) ---
    let attempt = 0;       // 0-indexed; grows on unstable disconnect, resets on stable
    let totalSpentMs = 0;  // cumulative backoff spent this episode; resets on stable
    let retryLogged = false; // dedup: print "connection lost" once per episode

    // --- Per-connection state (reset each connect()) ---
    let connectTimeMs = 0;
    let framesReceived = 0;
    let taskClosed = false;
    let disconnecting = false;

    // Mutable send ref — updated on each new connection so readline/SIGINT always
    // writes to the current socket. Noop during backoff gaps.
    let send: (m: AttachInbound) => void = () => {};

    // --- Renderer state (persists across reconnects) ---
    let pendingRequestId: number | undefined;
    let turnCount = 0;
    let turnStartMs = 0;
    let inTurn = false;
    let state: RendererState = "idle";
    let attachedOnce = false;

    const elapsed = () => (turnStartMs ? Date.now() - turnStartMs : 0);
    const writeStatus = () => process.stdout.write(formatStatus(state, turnCount, elapsed()) + "\n");

    let buf = "";

    function handleDisconnect(errorMsg?: string): void {
      if (disconnecting) return; // guard: error fires before close in Node.js
      disconnecting = true;
      send = () => {}; // noop until next connect()

      if (errorMsg) {
        process.stderr.write(`\n${chalk.red(`(socket error: ${errorMsg})`)}\n`);
      }

      if (taskClosed) {
        // Task ended cleanly via "closed" frame — no retry needed.
        process.stderr.write("\n" + formatConnectionClosed() + "\n");
        process.exit(0);
        return;
      }

      const stable = isConnectionStable(connectTimeMs, framesReceived, Date.now());

      if (stable) {
        // New episode: the lost connection was healthy, so reset budget and backoff.
        attempt = 0;
        totalSpentMs = 0;
        retryLogged = false;
      }

      if (!retryLogged) {
        process.stderr.write("\n" + formatConnectionLost() + "\n");
        retryLogged = true;
      }

      const delay = computeBackoffDelay(attempt);
      if (!stable) attempt += 1; // grow backoff only on unstable; stable already reset to 0

      totalSpentMs += delay;
      if (totalSpentMs > RETRY_BUDGET_MS) {
        process.stderr.write(formatReattachFailed(taskId) + "\n");
        process.exit(1);
        return;
      }

      setTimeout(connect, delay);
    }

    function connect(): void {
      connectTimeMs = 0;
      framesReceived = 0;
      taskClosed = false;
      disconnecting = false;
      buf = "";

      const conn = createConnection(socketPath());
      send = (m: AttachInbound) => conn.write(JSON.stringify(m) + "\n");

      conn.on("connect", () => {
        connectTimeMs = Date.now();
        send({ op: "attach", taskId });
      });

      conn.on("data", (chunk) => {
        buf += chunk.toString();
        const lastNl = buf.lastIndexOf("\n");
        if (lastNl < 0) return;
        const consumable = buf.slice(0, lastNl + 1);
        buf = buf.slice(lastNl + 1);
        for (const f of decodeFrames(consumable)) render(f);
      });

      conn.on("close", () => handleDisconnect());
      conn.on("error", (e) => handleDisconnect(e.message));
    }

    function render(f: AttachFrame): void {
      switch (f.type) {
        case "delta":
          framesReceived += 1;
          process.stdout.write(f.text);
          break;
        case "turn-started":
          framesReceived += 1;
          turnCount += 1;
          turnStartMs = Date.now();
          inTurn = true;
          state = "working";
          process.stdout.write("\n" + formatTurnHeader(turnCount) + "\n");
          writeStatus();
          break;
        case "turn-completed":
          framesReceived += 1;
          process.stdout.write("\n" + formatTurnFooter(elapsed()) + "\n");
          state = "idle";
          inTurn = false;
          process.stdout.write(formatDoneFollowup() + "\n> ");
          break;
        case "input-requested":
          framesReceived += 1;
          pendingRequestId = f.requestId;
          state = "awaiting-input";
          process.stdout.write("\n" + formatInputQuestion(f.question) + "\n" + formatInputPrompt());
          break;
        case "approval-requested":
          framesReceived += 1;
          pendingRequestId = f.requestId;
          state = "blocked";
          process.stdout.write("\n" + formatApproval(f.kind, f.question) + "\n" + formatApprovalPrompt());
          break;
        case "gate-promoted":
          framesReceived += 1;
          process.stdout.write("\n" + formatGatePromoted(f.gateId) + "\n> ");
          break;
        case "reattached":
          framesReceived += 1;
          process.stdout.write("\n" + (attachedOnce ? formatReattached() : formatAttached()) + "\n> ");
          attachedOnce = true;
          break;
        case "closed":
          taskClosed = true;
          process.stdout.write("\n" + formatClosed(f.reason) + "\n");
          break;
        case "_keepalive":
          break;
      }
    }

    connect();

    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (text) => {
      if (pendingRequestId != null) {
        const lower = text.toLowerCase();
        const decision = lower.startsWith("approve") ? "approve" : lower.startsWith("deny") ? "deny" : undefined;
        send({ op: "answer", taskId, requestId: pendingRequestId, payload: { text, decision } });
        pendingRequestId = undefined;
        if (state === "awaiting-input" || state === "blocked") state = "working";
      } else {
        send({ op: "say", taskId, text });
      }
    });
    process.on("SIGINT", () => send({ op: "interrupt", taskId }));
  });
