// Persisted Telegram bridge state: getUpdates offset + (project,scope) → topicId
// registry. Synchronous JSON in stateRoot/telegram-state.json.
import fs from "node:fs";
import path from "node:path";

export interface TelegramState {
  offset: number;
  /** key = `${project}::${scope}` (see topicKey); value = message_thread_id. */
  topics: Record<string, number>;
}

function statePath(stateRoot: string): string {
  return path.join(stateRoot, "telegram-state.json");
}

/** Registry key for a topic. v1 only ever uses scope "project"; per-crew routing
 *  (scope "crew:<taskId>") is additive later without a schema change. */
export function topicKey(project: string, scope = "project"): string {
  return `${project}::${scope}`;
}

export function loadState(stateRoot: string): TelegramState {
  try {
    const raw = fs.readFileSync(statePath(stateRoot), "utf-8");
    const data = JSON.parse(raw) as Partial<TelegramState>;
    return {
      offset: typeof data.offset === "number" ? data.offset : 0,
      topics: data.topics ?? {},
    };
  } catch {
    return { offset: 0, topics: {} };
  }
}

export function saveState(stateRoot: string, s: TelegramState): void {
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(statePath(stateRoot), JSON.stringify(s, null, 2) + "\n");
}

export function setTopic(
  stateRoot: string,
  project: string,
  topicId: number,
  scope = "project",
): void {
  const s = loadState(stateRoot);
  s.topics[topicKey(project, scope)] = topicId;
  saveState(stateRoot, s);
}

export function findProjectByThread(
  stateRoot: string,
  threadId: number,
): { project: string; scope: string } | null {
  const s = loadState(stateRoot);
  for (const [key, id] of Object.entries(s.topics)) {
    if (id !== threadId) continue;
    const sep = key.indexOf("::");
    if (sep === -1) continue;
    return { project: key.slice(0, sep), scope: key.slice(sep + 2) };
  }
  return null;
}
