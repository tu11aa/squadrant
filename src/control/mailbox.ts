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

export async function appendToMailbox(opts: AppendOpts): Promise<number> {
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
}
