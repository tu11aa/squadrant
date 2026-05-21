// src/commands/crew-attach.ts
import { Command } from "commander";
import chalk from "chalk";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { decodeFrames, type AttachFrame, type AttachInbound } from "../control/protocol.js";

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

export function formatGatePromoted(gateId: string): string {
  return chalk.dim(`(no client was attached; question promoted to gate ${gateId})`);
}

// --- CLI command ---

export const crewAttachCommand = new Command("attach")
  .description("Attach to a live interactive task (renders deltas; takes follow-ups). Spec §4.6.")
  .argument("<taskId>", "task id to attach to")
  .action((taskId: string) => {
    const conn = createConnection(socketPath());
    const send = (m: AttachInbound) => conn.write(JSON.stringify(m) + "\n");
    conn.on("connect", () => send({ op: "attach", taskId }));
    let pendingRequestId: number | undefined;
    let buf = "";

    // Renderer state
    let turnCount = 0;
    let turnStartMs = 0;
    let inTurn = false;
    let state: RendererState = "idle";
    let attachedOnce = false;

    const elapsed = () => (turnStartMs ? Date.now() - turnStartMs : 0);
    const writeStatus = () => process.stdout.write(formatStatus(state, turnCount, elapsed()) + "\n");

    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const lastNl = buf.lastIndexOf("\n");
      if (lastNl < 0) return;
      const consumable = buf.slice(0, lastNl + 1);
      buf = buf.slice(lastNl + 1);
      for (const f of decodeFrames(consumable)) render(f);
    });
    conn.on("close", () => { process.stderr.write("\n" + formatConnectionClosed() + "\n"); process.exit(0); });
    conn.on("error", (e) => { process.stderr.write(`\n${chalk.red(`(socket error: ${e.message})`)}\n`); process.exit(1); });

    function render(f: AttachFrame): void {
      switch (f.type) {
        case "delta":
          process.stdout.write(f.text);
          break;
        case "turn-started":
          turnCount += 1;
          turnStartMs = Date.now();
          inTurn = true;
          state = "working";
          process.stdout.write("\n" + formatTurnHeader(turnCount) + "\n");
          writeStatus();
          break;
        case "turn-completed":
          process.stdout.write("\n" + formatTurnFooter(elapsed()) + "\n");
          state = "idle";
          inTurn = false;
          process.stdout.write(formatDoneFollowup() + "\n> ");
          break;
        case "input-requested":
          pendingRequestId = f.requestId;
          state = "awaiting-input";
          process.stdout.write("\n" + formatInputQuestion(f.question) + "\n" + formatInputPrompt());
          break;
        case "approval-requested":
          pendingRequestId = f.requestId;
          state = "blocked";
          process.stdout.write("\n" + formatApproval(f.kind, f.question) + "\n" + formatApprovalPrompt());
          break;
        case "gate-promoted":
          process.stdout.write("\n" + formatGatePromoted(f.gateId) + "\n> ");
          break;
        case "reattached":
          process.stdout.write("\n" + (attachedOnce ? formatReattached() : formatAttached()) + "\n> ");
          attachedOnce = true;
          break;
        case "closed":
          process.stdout.write("\n" + formatClosed(f.reason) + "\n");
          break;
        case "_keepalive":
          break;
      }
    }

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
