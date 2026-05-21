// src/commands/crew-attach.ts
import { Command } from "commander";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { decodeFrames, type AttachFrame, type AttachInbound } from "../control/protocol.js";

function socketPath(): string {
  return process.env.COCKPITD_SOCK ?? join(homedir(), ".config", "cockpit", "cockpit.sock");
}

export const crewAttachCommand = new Command("attach")
  .description("Attach to a live interactive task (renders deltas; takes follow-ups). Spec §4.6.")
  .argument("<taskId>", "task id to attach to")
  .action((taskId: string) => {
    const conn = createConnection(socketPath());
    const send = (m: AttachInbound) => conn.write(JSON.stringify(m) + "\n");
    conn.on("connect", () => send({ op: "attach", taskId }));
    let pendingRequestId: number | undefined;
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const lastNl = buf.lastIndexOf("\n");
      if (lastNl < 0) return;
      const consumable = buf.slice(0, lastNl + 1);
      buf = buf.slice(lastNl + 1);
      for (const f of decodeFrames(consumable)) render(f);
    });
    conn.on("close", () => { process.stderr.write("\n(connection closed)\n"); process.exit(0); });
    conn.on("error", (e) => { process.stderr.write(`\n(socket error: ${e.message})\n`); process.exit(1); });

    function render(f: AttachFrame): void {
      switch (f.type) {
        case "delta": process.stdout.write(f.text); break;
        case "turn-started": process.stdout.write("\n[codex]\n"); break;
        case "turn-completed":
          process.stdout.write("\n[done — type a follow-up or Ctrl-C]\n> "); break;
        case "input-requested":
          pendingRequestId = f.requestId;
          process.stdout.write(`\n[codex asks] ${f.question}\n[answer]> `); break;
        case "approval-requested":
          pendingRequestId = f.requestId;
          process.stdout.write(`\n[approval] ${f.kind}: ${f.question}\n[approve/deny]> `); break;
        case "gate-promoted":
          process.stdout.write(`\n(no client was attached; question promoted to gate ${f.gateId})\n> `); break;
        case "reattached":
          process.stdout.write("\n(attached)\n> "); break;  // ack on first/re-attach
        case "closed":
          process.stdout.write(`\n(closed: ${f.reason})\n`); break;
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
      } else {
        send({ op: "say", taskId, text });
      }
    });
    process.on("SIGINT", () => send({ op: "interrupt", taskId }));
  });
