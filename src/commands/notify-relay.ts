// src/commands/notify-relay.ts
//
// Mailbox-injector refactor: notify-relay is now a file-tailing process that
// reads from a project's mailbox (.config/cockpit/inbox/<project>.log) using a
// durable per-subscriber cursor. Each delivered event is forwarded to the
// captain's primary surface via the runtime driver's sendToSurface. The
// cursor only advances after a successful send, so failed deliveries are
// naturally retried on the next poll.

import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { RuntimeRegistry, createCmuxDriver } from "../runtimes/index.js";
import type { RuntimeDriver } from "../runtimes/types.js";
import {
  readCursor,
  writeCursor,
  readFromCursor,
  type MailboxEntry,
} from "../control/mailbox.js";

export const DEFAULT_STATE_ROOT = join(homedir(), ".config", "cockpit", "state");

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatEntry(entry: MailboxEntry): string | null {
  const tag = `[${entry.provider}/${entry.name != null ? entry.name : shortId(entry.taskId)}]`;
  switch (entry.kind) {
    case "task.started":
    case "task.progress":
      return null; // suppress liveness/start
    case "task.done": {
      const msg =
        (entry.payload.message as string | undefined) ??
        (entry.payload.resultRef as string | undefined) ??
        "(no message)";
      return `CREW DONE ${tag}: ${msg.toString().split(/\r?\n/)[0].slice(0, 200)}`;
    }
    case "task.blocked":
      return `CREW BLOCKED ${tag}: ${(entry.payload.question as string | undefined) ?? "(no question)"}`;
    case "task.failed":
      return `CREW FAILED ${tag}: ${(entry.payload.error as string | undefined) ?? "(no error)"}`;
    case "task.stalled":
      return `CREW STALLED ${tag}: no heartbeat`;
    default:
      return null;
  }
}

interface RunOpts {
  project: string;
  subscriber: string;
  stateRoot: string;
  runtime: RuntimeDriver;
  captainName: string;
  pollMs?: number;
  log?: (m: string) => void;
}

export async function runNotifyRelay(opts: RunOpts): Promise<() => void> {
  const log =
    opts.log ?? ((m: string) => process.stdout.write(`[notify-relay ${opts.project}] ${m}\n`));

  // Resolve captain workspace + primary surface once at boot.
  const ws = await opts.runtime.status(opts.captainName);
  if (!ws) throw new Error(`captain workspace '${opts.captainName}' not running`);
  const surfaces =
    (await (opts.runtime as RuntimeDriver & {
      listSurfaces?: (id: string) => Promise<Array<{ title?: string }>>;
    }).listSurfaces?.(ws.id)) ?? [];
  const captainSurface =
    (surfaces.find((s) => s.title === opts.captainName) ?? surfaces[0]) as {
      workspaceId?: string;
      surfaceId?: string;
      title?: string;
    } | undefined;
  if (!captainSurface) throw new Error("no surfaces in captain workspace");

  const cursor = await readCursor({
    stateRoot: opts.stateRoot,
    project: opts.project,
    subscriber: opts.subscriber,
  });
  let lastAcked = cursor?.lastAckedSeq ?? 0;
  let stopped = false;
  let draining = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for await (const entry of readFromCursor({
        stateRoot: opts.stateRoot,
        project: opts.project,
        fromSeq: lastAcked + 1,
      })) {
        if (stopped) return;
        const msg = formatEntry(entry);
        if (msg) {
          try {
            await (opts.runtime as RuntimeDriver & {
              sendToSurface: (s: unknown, m: string) => Promise<void>;
            }).sendToSurface(captainSurface, msg);
          } catch (e) {
            log(`sendToSurface failed seq=${entry.seq}: ${(e as Error).message}`);
            // Don't advance cursor; the next poll will retry from the same seq.
            return;
          }
        }
        await writeCursor({
          stateRoot: opts.stateRoot,
          project: opts.project,
          subscriber: opts.subscriber,
          lastAckedSeq: entry.seq,
        });
        lastAcked = entry.seq;
      }
    } finally {
      draining = false;
    }
  }

  const interval = setInterval(() => {
    if (!stopped) drain().catch((e) => log(`drain error: ${(e as Error).message}`));
  }, opts.pollMs ?? 1000);

  await drain(); // initial drain

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

export const notifyRelayCommand = new Command("notify-relay")
  .description(
    "Subscribe to a project's mailbox and deliver events to the captain pane. " +
      "Long-running tailer; reads from .config/cockpit/inbox/<project>.log " +
      "using a per-subscriber cursor.",
  )
  .argument("<project>", "Project to relay mailbox events for")
  .option("--as <subscriber>", "subscriber name", "captain")
  .option("--state-root <path>", "override state root", DEFAULT_STATE_ROOT)
  .action(async (project: string, opts: { as: string; stateRoot: string }) => {
    try {
      const config = loadConfig();
      const projCfg = config.projects[project];
      if (!projCfg) {
        console.error(chalk.red(`notify-relay: unknown project '${project}'`));
        process.exit(1);
      }
      const registry = new RuntimeRegistry({ cmux: createCmuxDriver() });
      const runtime = registry.forProject(project, config);
      process.stdout.write(
        `[notify-relay ${project}] subscriber=${opts.as} stateRoot=${opts.stateRoot}\n`,
      );
      await runNotifyRelay({
        project,
        subscriber: opts.as,
        stateRoot: opts.stateRoot,
        runtime,
        captainName: projCfg.captainName,
        pollMs: 1000,
      });
      process.on("SIGTERM", () => process.exit(0));
    } catch (err) {
      console.error(chalk.red(`notify-relay: ${(err as Error).message}`));
      process.exit(1);
    }
  });
