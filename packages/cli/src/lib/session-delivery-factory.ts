// #1096: delivery deps for `side send` / `thread park`. The peer channel is the
// same ClaudePeerChannel `crew send` uses, keyed by the pinned socket path
// instead of a task id; the fallback is the #1087 confirmed-submit chokepoint.
import { randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";
import chalk from "chalk";
import { ClaudePeerChannel, readClaudeStatusBySocketPath, writeLine } from "@squadrant/agents";
import type { RuntimeDriver } from "@squadrant/shared";
import type { SessionDeliveryDeps } from "@squadrant/core";
import { confirmedSendToPane } from "@squadrant/workspaces";
import { createCliReceiptListener } from "./captain-channel-factory.js";

export async function withSessionDelivery<T>(
  runtime: RuntimeDriver,
  run: (delivery: SessionDeliveryDeps) => Promise<T>,
): Promise<T> {
  const receipts = createCliReceiptListener();
  // A listener that cannot bind must not take the pane fallback down with it.
  const listening = await receipts.start().then(() => true, (e: Error) => { console.error(chalk.dim(`peer receipts unavailable, using the pane: ${e.message}`)); return false; });
  try {
    return await run({
      ...(listening ? { channel: new ClaudePeerChannel({
        socketPathFor: (socketPath) => socketPath,
        sessionIdFor: (socketPath) => readClaudeStatusBySocketPath(socketPath)?.sessionId,
        statusFor: readClaudeStatusBySocketPath,
        wire: (p, e) => writeLine(p, e, { connect: (path) => netConnect(path) }),
        receipts,
        newMsgId: () => randomUUID(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        log: (m) => console.error(chalk.dim(m)),
      }) } : {}),
      sendToPane: (pane, msg) => confirmedSendToPane(runtime, pane, msg),
      log: (m) => console.error(chalk.dim(m)),
    });
  } finally {
    receipts.stop();
  }
}
