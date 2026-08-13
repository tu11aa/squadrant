// Persisted Telegram bridge state: getUpdates offset + (project,scope) → topicId
// registry. Synchronous JSON in stateRoot/telegram-state.json.
import fs from "node:fs";
import path from "node:path";
import { readConfigFileSync, writeConfigFileSync } from "@squadrant/shared";

export interface TelegramState {
  offset: number;
  /** key = `${project}::${scope}` (see topicKey); value = message_thread_id. */
  topics: Record<string, number>;
  /** key = project; value = true when active. Absent/false = MUTED (default). */
  notify: Record<string, boolean>;
  /** Last seen inbound message sender — populated passively by the bridge poll. */
  lastUserId?: number;
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
    const raw = readConfigFileSync(statePath(stateRoot));
    const data = JSON.parse(raw) as Partial<TelegramState>;
    const result: TelegramState = {
      offset: typeof data.offset === "number" ? data.offset : 0,
      topics: data.topics ?? {},
      notify: data.notify ?? {},
    };
    if (typeof data.lastUserId === "number") result.lastUserId = data.lastUserId;
    return result;
  } catch {
    return { offset: 0, topics: {}, notify: {} };
  }
}

export function saveState(stateRoot: string, s: TelegramState): void {
  writeConfigFileSync(statePath(stateRoot), JSON.stringify(s, null, 2) + "\n");
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

export function isNotifyActive(stateRoot: string, project: string): boolean {
  return loadState(stateRoot).notify[project] === true;
}

export function setLastUserId(stateRoot: string, id: number): void {
  const s = loadState(stateRoot);
  s.lastUserId = id;
  saveState(stateRoot, s);
}

export function setNotify(stateRoot: string, project: string, active: boolean): void {
  const s = loadState(stateRoot);
  s.notify[project] = active;
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
