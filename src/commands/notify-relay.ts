// src/commands/notify-relay.ts
//
// #111: in-cmux relay for daemon push notifications. Runs in a captain-workspace
// tab so that cmux's process-lineage check allows it to call `cmux send` (the
// daemon itself cannot — it's a launchd child, not a cmux descendant).
//
// Long-running process. Subscribes to the daemon socket via the
// `subscribe-notify` claim frame; for each pushed message, forwards it to the
// project's captain workspace using the runtime driver. Reconnects with
// backoff if the daemon restarts.

import { Command } from "commander";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { RuntimeRegistry, createCmuxDriver } from "../runtimes/index.js";
import type { AttachFrame } from "../control/protocol.js";
import { createDecoder, encodeMsg } from "../control/protocol.js";

const SOCK_PATH = join(homedir(), ".config", "cockpit", "cockpit.sock");

interface RunOpts {
  sockPath?: string;
  // Test injection: builds the runtime + resolves captain name. Defaults to the
  // production config loader + cmux driver. The returned `send` must already
  // be bound to the captain's runtime-native ref (workspace ID), because
  // cmux's driver.send() expects an ID, not a name.
  resolve?: (project: string) => Promise<{ captainName: string; send: (msg: string) => Promise<void> }>;
  // Test injection: when true, exit after the first daemon-end (no reconnect loop).
  once?: boolean;
  // Test injection: backoff override (ms). Production uses 1s/2s/4s capped at 30s.
  backoffMs?: (attempt: number) => number;
  log?: (m: string) => void;
}

function defaultBackoff(attempt: number): number {
  return Math.min(30_000, 1_000 * Math.pow(2, attempt));
}

export async function runNotifyRelay(project: string, opts: RunOpts = {}): Promise<void> {
  const sockPath = opts.sockPath ?? SOCK_PATH;
  const log = opts.log ?? ((m: string) => process.stdout.write(`[notify-relay ${project}] ${m}\n`));
  const backoff = opts.backoffMs ?? defaultBackoff;

  const resolve = opts.resolve ?? (async () => {
    const config = loadConfig();
    const proj = config.projects[project];
    if (!proj) throw new Error(`Project '${project}' not found in config`);
    const registry = new RuntimeRegistry({ cmux: createCmuxDriver() });
    const driver = registry.forProject(project, config);
    // RuntimeDriver.send() expects the runtime-native ref (e.g. cmux's
    // "workspace:N"), not the human name — resolve once at startup.
    const ref = await driver.status(proj.captainName);
    if (!ref) {
      throw new Error(`Captain workspace '${proj.captainName}' not found in runtime '${driver.name}'`);
    }
    return {
      captainName: proj.captainName,
      send: (msg: string) => driver.send(ref.id, msg),
    };
  });

  const r = await resolve(project);
  log(`relaying to captain '${r.captainName}' via socket ${sockPath}`);

  let attempt = 0;
  while (true) {
    const ended = await connectOnce(sockPath, project, r.send, log);
    if (opts.once) return;
    if (ended === "fatal") return;
    const wait = backoff(attempt++);
    log(`daemon connection lost; reconnecting in ${wait}ms`);
    await new Promise((res) => setTimeout(res, wait));
  }
}

function connectOnce(
  sockPath: string,
  project: string,
  send: (msg: string) => Promise<void>,
  log: (m: string) => void,
): Promise<"end" | "fatal"> {
  return new Promise((resolve) => {
    let conn: Socket;
    try {
      conn = createConnection(sockPath);
    } catch (e) {
      log(`connect threw: ${(e as Error).message}`);
      resolve("end");
      return;
    }
    const dec = createDecoder();
    conn.setEncoding("utf-8");
    conn.on("connect", () => {
      conn.write(encodeMsg({ op: "subscribe-notify", project }));
      log("subscribed");
    });
    conn.on("data", (chunk: string) => {
      for (const raw of dec.push(chunk)) {
        const frame = raw as AttachFrame;
        if (frame && (frame as any).type === "push" && (frame as any).project === project) {
          const message = (frame as any).message as string;
          // Fire-and-forget; runtime.send failures are logged but don't tear down the relay.
          send(message).catch((e: Error) => log(`send failed: ${e.message}`));
        }
      }
    });
    conn.on("error", (e: Error) => {
      log(`socket error: ${e.message}`);
    });
    conn.on("close", () => {
      resolve("end");
    });
  });
}

export const notifyRelayCommand = new Command("notify-relay")
  .description(
    "In-cmux relay: subscribes to daemon push notifications for <project> and " +
      "forwards them to the project's captain pane via the runtime driver. " +
      "Spawned automatically as a tab in each captain workspace; not intended " +
      "to be invoked manually.",
  )
  .argument("<project>", "Project to relay push notifications for")
  .action(async (project: string) => {
    try {
      await runNotifyRelay(project);
    } catch (err) {
      console.error(chalk.red(`notify-relay: ${(err as Error).message}`));
      process.exit(1);
    }
  });
