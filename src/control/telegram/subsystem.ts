// src/control/telegram/subsystem.ts
import { loadTelegramState, type TelegramState } from "./state.js";
import { crewTopicName, inboundCaptainMessage } from "./format.js";
import type { TelegramClient, TgUpdate } from "./client.js";
import type { TaskRecord } from "../types.js";
import { TERMINAL_STATES } from "../types.js";

export interface TelegramSubsystemDeps {
  client: TelegramClient;
  /** project → supergroup chat_id (also the inbound allowlist). */
  chats: Record<string, number>;
  stateRoot: string;
  /** Inbound delivery seam — bound to mailbox.appendCaptainMessage by the daemon. */
  appendCaptainMessage: (opts: { stateRoot: string; project: string; message: string; taskId?: string; name?: string }) => Promise<number>;
  /** Resolve a crew display name from a taskId (store lookup), used on inbound. */
  resolveCrewName: (project: string, taskId: string) => string | undefined;
  log: (m: string) => void;
}

export interface TelegramSubsystem {
  pushLifecycle(args: { project: string; message: string; record: TaskRecord }): Promise<void>;
  startInbound(): void;
  stop(): void;
}

export interface InboundRouterDeps {
  update: TgUpdate;
  chats: Record<string, number>;
  findTask: (threadId: number) => { project: string; taskId: string } | undefined;
  resolveCrewName: (project: string, taskId: string) => string | undefined;
  appendCaptainMessage: TelegramSubsystemDeps["appendCaptainMessage"];
  stateRoot: string;
  log: (m: string) => void;
}

/** Pure-ish: route ONE update. Returns true if it produced a captain message. */
export async function processInboundUpdate(deps: InboundRouterDeps): Promise<boolean> {
  const msg = deps.update.message;
  if (!msg || !msg.text) return false;

  // Allowlist: chat must be a linked supergroup. Reverse chat_id → project.
  const entry = Object.entries(deps.chats).find(([, id]) => id === msg.chat.id);
  if (!entry) {
    deps.log(`telegram inbound ignored: chat ${msg.chat.id} not allowlisted`);
    return false;
  }
  const [project] = entry;

  // Resolve target task from the topic thread (absent / unknown → captain).
  const found = msg.message_thread_id !== undefined ? deps.findTask(msg.message_thread_id) : undefined;
  const taskId = found?.taskId;
  const crewName = found ? deps.resolveCrewName(found.project, found.taskId) : undefined;

  await deps.appendCaptainMessage({
    stateRoot: deps.stateRoot,
    project,
    message: inboundCaptainMessage(crewName, msg.text),
    taskId,
    name: crewName,
  });
  return true;
}

export async function createTelegramSubsystem(deps: TelegramSubsystemDeps): Promise<TelegramSubsystem> {
  const state: TelegramState = await loadTelegramState(deps.stateRoot);

  async function topicFor(project: string, chatId: number, record: TaskRecord): Promise<number> {
    const existing = state.getTopic(project, record.id);
    if (existing !== undefined) return existing;
    const threadId = await deps.client.createForumTopic(chatId, crewTopicName(record.name ?? record.id));
    await state.setTopic(project, record.id, threadId);
    return threadId;
  }

  async function pushLifecycle(args: { project: string; message: string; record: TaskRecord }): Promise<void> {
    try {
      const chatId = deps.chats[args.project];
      if (chatId === undefined) return; // project not linked
      const threadId = await topicFor(args.project, chatId, args.record);
      await deps.client.sendMessage(chatId, args.message, threadId);
      if (TERMINAL_STATES.has(args.record.state)) {
        await deps.client.closeForumTopic(chatId, threadId);
      }
    } catch (e) {
      deps.log(`telegram push failed project=${args.project}: ${(e as Error).message}`);
    }
  }

  let stopped = false;
  let abort: AbortController | undefined;

  function startInbound(): void {
    void (async () => {
      while (!stopped) {
        try {
          abort = new AbortController();
          const updates = await deps.client.getUpdates(state.offset(), 30, abort.signal);
          for (const update of updates) {
            await processInboundUpdate({
              update,
              chats: deps.chats,
              findTask: state.findTask.bind(state),
              resolveCrewName: deps.resolveCrewName,
              appendCaptainMessage: deps.appendCaptainMessage,
              stateRoot: deps.stateRoot,
              log: deps.log,
            });
            await state.setOffset(update.update_id + 1);
          }
        } catch (e) {
          if (stopped) return;
          deps.log(`telegram inbound loop error: ${(e as Error).message}`);
          await new Promise((r) => setTimeout(r, 3000)); // backoff; never tight-loops
        }
      }
    })();
  }

  function stop(): void {
    stopped = true;
    abort?.abort();
  }

  return { pushLifecycle, startInbound, stop };
}
