import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { TaskRecord, ControlEvent } from "./types.js";

export interface MailboxEntry {
  seq: number;
  ts: string;
  taskId: string;
  /** Optional human-readable name carried from TaskRecord. Absent on legacy
   *  records — readers must fall back to shortId(taskId). */
  name?: string;
  kind: ControlEvent["type"];
  provider: TaskRecord["provider"];
  payload: Record<string, unknown>;
  /** Daemon-rendered captain-facing message (unified-formatter, #214/#210).
   *  The daemon's formatMessage is the single source of truth; the relay
   *  delivers this verbatim and skips entries where it is null/empty.
   *  `null` on entries the daemon chose not to surface (and legacy records). */
  message?: string | null;
}

interface AppendOpts {
  stateRoot: string;
  project: string;
  taskRecord: TaskRecord;
  event: ControlEvent;
  /** Captain-facing message rendered by the daemon (daemon.ts formatMessage). */
  message?: string | null;
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

async function listRotatedOldestFirst(stateRoot: string, project: string): Promise<string[]> {
  const dir = inboxDir(stateRoot);
  let entries: string[];
  try { entries = await fs.readdir(dir); }
  catch { return []; }
  const prefix = `${project}.log.`;
  return entries
    .filter((e) => e.startsWith(prefix) && /^\d+$/.test(e.slice(prefix.length)))
    .map((e) => ({ name: e, n: Number(e.slice(prefix.length)) }))
    .sort((a, b) => b.n - a.n) // .3 first (oldest), .1 last (newest rotated)
    .map((e) => join(dir, e.name));
}

async function readMaxSeqFromFile(file: string): Promise<number> {
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

async function readMaxSeq(stateRoot: string, project: string): Promise<number> {
  let max = 0;
  const files = [
    logPath(stateRoot, project),
    ...(await listRotatedOldestFirst(stateRoot, project)),
  ];
  for (const file of files) {
    const seq = await readMaxSeqFromFile(file);
    if (seq > max) max = seq;
  }
  return max;
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
    const lastSeq = await readMaxSeq(opts.stateRoot, opts.project);
    const seq = lastSeq + 1;
    const entry: MailboxEntry = {
      seq,
      ts: new Date().toISOString(),
      taskId: opts.taskRecord.id,
      ...(opts.taskRecord.name !== undefined ? { name: opts.taskRecord.name } : {}),
      kind: opts.event.type,
      provider: opts.taskRecord.provider,
      payload: extractPayload(opts.event),
      message: opts.message ?? null,
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

interface ReadFromCursorOpts {
  stateRoot: string;
  project: string;
  fromSeq: number;
}

export async function* readFromCursor(opts: ReadFromCursorOpts): AsyncIterable<MailboxEntry> {
  // Order: oldest rotated first (.3 → .2 → .1), then current.
  const rotated = await listRotatedOldestFirst(opts.stateRoot, opts.project);
  const files = [...rotated, logPath(opts.stateRoot, opts.project)];
  for (const file of files) {
    let buf: string;
    try {
      buf = await fs.readFile(file, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      let entry: MailboxEntry;
      try {
        entry = JSON.parse(line) as MailboxEntry;
      } catch {
        continue;
      }
      if (entry.seq >= opts.fromSeq) yield entry;
    }
  }
}

/** Read-only Tier 2 observability stats for one project's mailbox (#44 dashboard). */
export interface MailboxStats {
  /** Highest seq across the current log + rotated segments (0 when empty). */
  maxSeq: number;
  /** Size in bytes of the current (un-rotated) log file. */
  sizeBytes: number;
  /** Age of the oldest entry in the current log (0 when empty/missing). */
  oldestEntryAgeMs: number;
  /** Number of rotated segments on disk (<project>.log.1, .2, …). */
  rotationCount: number;
}

/**
 * Read-only stats for the dashboard's Tier 2 data-plane view. Never mutates;
 * tolerates a missing inbox (returns zeros). The daemon gathers this and passes
 * it to the pure snapshot assembler.
 */
export async function mailboxStats(stateRoot: string, project: string): Promise<MailboxStats> {
  const file = logPath(stateRoot, project);
  let sizeBytes = 0;
  try { sizeBytes = (await fs.stat(file)).size; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const rotated = await listRotatedOldestFirst(stateRoot, project);
  return {
    maxSeq: await readMaxSeq(stateRoot, project),
    sizeBytes,
    oldestEntryAgeMs: await oldestEntryAgeMs(file),
    rotationCount: rotated.length,
  };
}

interface RotateOpts {
  stateRoot: string;
  project: string;
  maxBytes: number;
  maxAgeMs: number;
  keepCount: number;
}

export interface RotateResult {
  rotated: boolean;
  from?: string;
  to?: string;
}

async function oldestEntryAgeMs(file: string): Promise<number> {
  try {
    const buf = await fs.readFile(file, "utf-8");
    const firstLine = buf.split("\n").find((l) => l.trim());
    if (!firstLine) return 0;
    const entry = JSON.parse(firstLine) as MailboxEntry;
    return Date.now() - new Date(entry.ts).getTime();
  } catch {
    return 0;
  }
}

export async function rotateIfNeeded(opts: RotateOpts): Promise<RotateResult> {
  return withProjectLock(opts.project, async () => {
    const file = logPath(opts.stateRoot, opts.project);
    let size = 0;
    try { size = (await fs.stat(file)).size; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { rotated: false };
      throw e;
    }
    const age = await oldestEntryAgeMs(file);
    if (size < opts.maxBytes && age < opts.maxAgeMs) return { rotated: false };

    // Shift existing .N files down (.N → .N+1), deleting anything beyond keepCount.
    // Process highest N first so we don't clobber.
    // Find the existing max N.
    const existing = await listRotatedOldestFirst(opts.stateRoot, opts.project);
    // existing is sorted by N desc (oldest first). Extract numbers.
    const nums = existing.map((p) => Number(p.slice(p.lastIndexOf(".") + 1))).sort((a, b) => b - a);
    for (const n of nums) {
      const src = `${file}.${n}`;
      const dst = `${file}.${n + 1}`;
      if (n + 1 > opts.keepCount) {
        try { await fs.unlink(src); } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      } else {
        try { await fs.rename(src, dst); } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
    }
    // current → .1
    await fs.rename(file, `${file}.1`);
    // create fresh empty current
    await fs.writeFile(file, "", { encoding: "utf-8" });
    return { rotated: true, from: file, to: `${file}.1` };
  });
}
