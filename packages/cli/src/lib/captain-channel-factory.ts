// packages/cli/src/lib/captain-channel-factory.ts
//
// #667 slice 4: build a ClaudePeerChannel aimed at ONE project's captain.
//
// A captain is not a TaskRecord, so every lookup here is keyed by project name
// and the "taskId" argument the port passes is the project name. That is a
// deliberate reuse of the port's shape, not a mistake — captainSocketPath()
// derives the address from the project name alone.

import { createServer, connect as netConnect } from "node:net";
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import { ClaudePeerChannel, ClaudeReceiptListener, writeLine, readClaudeStatusByCwd } from "@squadrant/agents";
import { captainSocketPath, CC_SOCKS_DIR } from "@squadrant/core";
import { loadConfig } from "@squadrant/shared";

let shared: ClaudeReceiptListener | undefined;

/** One listener per process — it binds a socket, so constructing several would EADDRINUSE. */
export async function sharedReceiptListener(): Promise<ClaudeReceiptListener> {
  if (shared) return shared;
  shared = new ClaudeReceiptListener({
    socketPath: `${CC_SOCKS_DIR}/squadrantd.sock`,
    createServer: (h) => createServer(h),
    log: (m) => console.error(chalk.dim(m)),
  });
  await shared.start();
  return shared;
}

export async function buildCaptainChannel(): Promise<ClaudePeerChannel> {
  const receipts = await sharedReceiptListener();
  const config = loadConfig();
  return new ClaudePeerChannel({
    // The port's taskId IS the project name for captains.
    socketPathFor: (taskId) => captainSocketPath(taskId),
    // We do not know a captain's session id, so the pid-reuse guard is skipped
    // here. Acceptable: the socket path is project-scoped and squadrant chose it
    // at launch, so a stale path fails as `gone` rather than reaching a stranger.
    sessionIdFor: () => undefined,
    // Captains are identified in the registry by their cwd (the project path).
    statusFor: (taskId) => {
      const projectPath = config.projects[taskId]?.path;
      return projectPath ? readClaudeStatusByCwd(projectPath) : undefined;
    },
    wire: (p, e) => writeLine(p, e, { connect: (path) => netConnect(path) }),
    receipts,
    newMsgId: () => randomUUID(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.error(chalk.dim(m)),
  });
}
