import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { TaskRecord, ControlEvent } from "./types.js";

export interface MailboxEntry {
  seq: number;
  ts: string;
  taskId: string;
  kind: ControlEvent["type"];
  provider: TaskRecord["provider"];
  payload: Record<string, unknown>;
}

interface AppendOpts {
  stateRoot: string;
  project: string;
  taskRecord: TaskRecord;
  event: ControlEvent;
}

function inboxDir(stateRoot: string): string {
  return join(stateRoot, "inbox");
}

function logPath(stateRoot: string, project: string): string {
  return join(inboxDir(stateRoot), `${project}.log`);
}

function extractPayload(event: ControlEvent): Record<string, unknown> {
  const { type: _type, id: _id, ...payload } = event as Record<string, unknown> & { type: string; id: string };
  return payload;
}

async function readMaxSeq(file: string): Promise<number> {
  try {
    const buf = await fs.readFile(file, "utf-8");
    if (!buf.trim()) return 0;
    const lines = buf.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]) as MailboxEntry;
        return obj.seq;
      } catch { continue; }
    }
    return 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
}

// Per-project serial mutex. Node's event loop is single-threaded but async
// readFile + writeFile can interleave; chaining all appends for the same
// project through a single in-process Promise serializes them.
//
// For cross-process serialization (multi-daemon scenarios, e.g. launchctl
// restart races), an OS-level flock would be needed on `<project>.log`.
// Today cockpit runs a single daemon instance; the in-process mutex covers
// the realistic concurrency model. flock can be added later if multi-process
// access becomes a requirement.
const projectLocks = new Map<string, Promise<unknown>>();

function withProjectLock<T>(project: string, fn: () => Promise<T>): Promise<T> {
  const prev = projectLocks.get(project) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  // Store a tail that does not reject so the chain never breaks on caller failure
  projectLocks.set(project, next.catch(() => undefined));
  return next;
}

export async function appendToMailbox(opts: AppendOpts): Promise<number> {
  return withProjectLock(opts.project, async () => {
    const dir = inboxDir(opts.stateRoot);
    await fs.mkdir(dir, { recursive: true });
    const file = logPath(opts.stateRoot, opts.project);
    const lastSeq = await readMaxSeq(file);
    const seq = lastSeq + 1;
    const entry: MailboxEntry = {
      seq,
      ts: new Date().toISOString(),
      taskId: opts.taskRecord.id,
      kind: opts.event.type,
      provider: opts.taskRecord.provider,
      payload: extractPayload(opts.event),
    };
    await fs.appendFile(file, JSON.stringify(entry) + "\n", { encoding: "utf-8" });
    return seq;
  });
}

function cursorPath(stateRoot: string, project: string, subscriber: string): string {
  return join(inboxDir(stateRoot), `${project}.${subscriber}.cursor`);
}

interface CursorOpts {
  stateRoot: string;
  project: string;
  subscriber: string;
}

export interface CursorState {
  lastAckedSeq: number;
  subscriber: string;
  updatedAt: string;
}

export async function readCursor(opts: CursorOpts): Promise<CursorState | null> {
  try {
    const buf = await fs.readFile(cursorPath(opts.stateRoot, opts.project, opts.subscriber), "utf-8");
    return JSON.parse(buf) as CursorState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeCursor(opts: CursorOpts & { lastAckedSeq: number }): Promise<void> {
  await fs.mkdir(inboxDir(opts.stateRoot), { recursive: true });
  const dest = cursorPath(opts.stateRoot, opts.project, opts.subscriber);
  const tmp = dest + ".tmp";
  const data: CursorState = {
    lastAckedSeq: opts.lastAckedSeq,
    subscriber: opts.subscriber,
    updatedAt: new Date().toISOString(),
  };
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(data), { encoding: "utf-8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, dest);
}
