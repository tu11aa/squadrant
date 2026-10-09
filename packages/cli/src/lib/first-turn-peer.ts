// #917: CLI-edge adapter that delivers a claude crew's first turn over the peer
// channel. Real deps (registry read, peer socket, receipt listener) are bound
// here; the readiness/trust/receipt logic lives in core's deliverFirstTurnViaPeer.
import { randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";
import { ClaudePeerChannel, readClaudeStatusBySocketPath, writeLine } from "@squadrant/agents";
import { deliverFirstTurnViaPeer, type PeerFirstTurnResult } from "@squadrant/core";
import type { PaneRef, RuntimeDriver, TaskRecord } from "@squadrant/shared";
import { sharedReceiptListener } from "./captain-channel-factory.js";

export async function sendClaudeFirstTurnViaPeer(
  runtime: Pick<RuntimeDriver, "readPaneScreen" | "sendKeyToPane">,
  o: { pane: PaneRef; taskId: string; messagingSocketPath: string; message: string },
  getTaskRecord: () => Promise<TaskRecord | undefined>,
): Promise<PeerFirstTurnResult> {
  const receipts = await sharedReceiptListener();
  const channel = new ClaudePeerChannel({
    socketPathFor: () => o.messagingSocketPath,
    sessionIdFor: () => readClaudeStatusBySocketPath(o.messagingSocketPath)?.sessionId,
    statusFor: () => readClaudeStatusBySocketPath(o.messagingSocketPath),
    wire: (p, e) => writeLine(p, e, { connect: (path) => netConnect(path) }),
    receipts,
    newMsgId: () => randomUUID(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // The UserPromptSubmit hook is the real receipt; don't hold spawn for the
    // default 4s inferred-flip window.
    confirmWindowMs: 1_500,
  });
  return deliverFirstTurnViaPeer(o.message, {
    statusOf: () => readClaudeStatusBySocketPath(o.messagingSocketPath),
    readScreen: async () => (await runtime.readPaneScreen(o.pane)) ?? "",
    pressKey: (key) => runtime.sendKeyToPane(o.pane, key),
    send: (m) => channel.send(o.taskId, m),
    isConfirmed: async () => !!(await getTaskRecord())?.firstTurnConfirmedAt,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  });
}
