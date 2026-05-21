import { Command } from "commander";
import { AppServerClient } from "../control/codex/app-server-client.js";
import { resolve } from "node:path";

export const codexChatSmokeCommand = new Command("codex-chat-smoke")
  .description("Phase 1 gate: prove the codex app-server JSON-RPC path works end-to-end.")
  .option("--cwd <dir>", "working dir for the codex thread", process.cwd())
  .option("--model <m>", "model id (optional)")
  .option(
    "--approval",
    "include the approval round-trip (Phase 1 PASS requires this)",
    false
  )
  .action(async (opts: { cwd: string; model?: string; approval: boolean }) => {
    const c = new AppServerClient({ clientInfo: { name: "cockpit", version: "smoke" } });
    const transcript: string[] = [];
    c.on("notification", (n) =>
      transcript.push(`> ${n.method} ${JSON.stringify(n.params).slice(0, 200)}`)
    );
    c.on("stderr", (s) => transcript.push(`[stderr] ${s.trim()}`));
    try {
      c.start();
      await c.initialize();
      const { threadId } = await c.startThread({
        cwd: resolve(opts.cwd),
        model: opts.model,
        sandbox: "workspace-write",
        // With --approval, force untrusted policy so codex requests approval
        // for any tool/shell invocation — proves the round-trip.
        ...(opts.approval ? { approvalPolicy: "untrusted" } : {}),
      });
      await c.sendTurn(threadId, "Reply with exactly: PING-OK");
      await assertSawText(transcript, "PING-OK");
      await c.sendTurn(threadId, "Now reply with: PONG-OK");
      await assertSawText(transcript, "PONG-OK");
      process.stdout.write("smoke: BASIC ok\n");
      if (!opts.approval) {
        c.kill();
        return;
      }

      // Approval round-trip — Phase-1 GATE.
      const pendingApprovals: Array<{ id: number; method: string }> = [];
      c.on("serverRequest", (r) => {
        pendingApprovals.push({ id: r.id, method: r.method });
        // Approve every approval-shaped request automatically (PASS-by-affirm).
        c.respondToServerRequest(r.id, { decision: "approve" });
      });
      // Ask codex to do something that needs approval (writing a file).
      await c.sendTurn(threadId, `Write the text "approval-ok" to a file at ${resolve(opts.cwd)}/.cockpit-smoke.txt`);
      if (pendingApprovals.length === 0) {
        throw new Error("approval gate: expected at least one server-request (approval/input) during the turn");
      }
      process.stdout.write(`smoke: APPROVAL ok (${pendingApprovals.length} request(s) handled)\n`);
      c.kill();
    } catch (e) {
      process.stderr.write(
        `smoke FAIL: ${(e as Error).message}\n${transcript.join("\n")}\n`
      );
      c.kill();
      process.exit(1);
    }
  });

async function assertSawText(transcript: string[], needle: string): Promise<void> {
  const hit = transcript.some((l) => l.includes(needle));
  if (!hit)
    throw new Error(
      `expected to see '${needle}' in delta stream\nTranscript:\n${transcript.join("\n")}`
    );
}
