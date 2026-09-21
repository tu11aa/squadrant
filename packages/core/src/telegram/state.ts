// Persisted Telegram bridge state: getUpdates offset + (project,scope) → topicId
// registry. Synchronous JSON in stateRoot/telegram-state.json.
import fs from "node:fs";
import path from "node:path";
import { readConfigFileSync, writeConfigFileSync } from "@squadrant/shared";

/** One outstanding "the captain should reply" expectation (#838/#839). Persisted
 *  so a daemon restart can resume/clear the typing keep-alive and the watchdog. */
export interface PendingReply {
  /** Telegram topic the expectation belongs to (typing target + warning route). */
  threadId: number;
  /** Epoch ms at which the captain was expected to start working on the message. */
  startedAt: number;
  /** Epoch ms the watchdog already warned. Presence = "do not nag again". */
  warnedAt?: number;
}

export interface TelegramState {
  offset: number;
  /** key = `${project}::${scope}` (see topicKey); value = message_thread_id. */
  topics: Record<string, number>;
  /** key = project; value = true when active. Absent/false = MUTED (default). */
  notify: Record<string, boolean>;
  /** Last seen inbound message sender — populated passively by the bridge poll. */
  lastUserId?: number;
  /** key = project; outstanding delivery awaiting a captain reply (#838/#839). */
  pending?: Record<string, PendingReply>;
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
    if (data.pending && Object.keys(data.pending).length > 0) result.pending = data.pending;
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

/** Read the persisted outstanding captain-reply expectations (#838/#839). */
export function loadPending(stateRoot: string): Record<string, PendingReply> {
  return loadState(stateRoot).pending ?? {};
}

/** Record (or replace) a project's outstanding reply expectation. */
export function setPending(stateRoot: string, project: string, p: PendingReply): void {
  const s = loadState(stateRoot);
  s.pending = { ...(s.pending ?? {}), [project]: p };
  saveState(stateRoot, s);
}

/** THE single "captain replied" signal (#838/#839). Clearing the pending entry
 *  is what stops the typing keep-alive (it self-stops on its next tick) and
 *  disarms the watchdog — both read this one store, so there is no second
 *  liveness detector to drift out of sync. No-op (no write) when absent. */
export function clearPending(stateRoot: string, project: string): void {
  const s = loadState(stateRoot);
  if (!s.pending || !(project in s.pending)) return;
  delete s.pending[project];
  if (Object.keys(s.pending).length === 0) delete s.pending;
  saveState(stateRoot, s);
}

/** Stamp that the watchdog warned for this pending delivery (fires once). */
export function markPendingWarned(stateRoot: string, project: string, at: number): void {
  const s = loadState(stateRoot);
  const p = s.pending?.[project];
  if (!p) return;
  s.pending![project] = { ...p, warnedAt: at };
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
