// src/dashboard/log-tail.ts
//
// Live tail of the daemon log file (squadrantd.log) for the dashboard's Logs
// tab (#519). Zero deps: reads byte ranges off the fd and keeps a bounded ring
// of the lines it has emitted, so every connected browser gets the SAME stream
// — a new client receives the ring as backlog and then continues live. Keeping
// the backlog in the ring (rather than re-reading the file per client) is what
// prevents duplicate lines between a re-read tail and the poll cursor.
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** How much history to seed on startup — matches the snapshot's 256KB tail cap
 *  so the dashboard never slurps an unbounded log. */
export const LOG_TAIL_BYTES = 256 * 1024;

/** Bounded backlog retained in memory and replayed to each new client. */
export const LOG_RING_SIZE = 1000;

export interface LogTailerDeps {
  /** File size in bytes (0 when missing). Injectable for tests. */
  size?: (path: string) => number;
  /** Read `len` bytes at `start`, utf-8. Injectable for tests. */
  read?: (path: string, start: number, len: number) => string;
}

function defaultSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function defaultRead(path: string, start: number, len: number): string {
  if (len <= 0) return "";
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, start);
      return buf.subarray(0, n).toString("utf-8");
    } finally { closeSync(fd); }
  } catch { return ""; }
}

/**
 * Stateful tailer over an append-only log. `init()` seeds the ring from the
 * current tail and pins the cursor at EOF; `poll()` returns lines appended
 * since the previous poll; `backlog()` is the ring replayed to a new client.
 */
export class LogTailer {
  private offset = 0;
  private pending = "";
  private ring: string[] = [];
  private readonly size: (path: string) => number;
  private readonly read: (path: string, start: number, len: number) => string;

  constructor(
    private readonly path: string,
    private readonly ringSize: number = LOG_RING_SIZE,
    deps: LogTailerDeps = {},
  ) {
    this.size = deps.size ?? defaultSize;
    this.read = deps.read ?? defaultRead;
  }

  /** Seed history from the last `maxBytes` and position the cursor at EOF.
   *  Idempotent; call once at startup. A trailing partial line stays pending
   *  so the next append completes it without loss or duplication. */
  init(maxBytes: number = LOG_TAIL_BYTES): void {
    const size = this.size(this.path);
    this.pending = "";
    this.ring = [];
    if (size <= 0) { this.offset = size; return; }
    const start = Math.max(0, size - maxBytes);
    const parts = this.read(this.path, start, size - start).split("\n");
    const rest = parts.pop() ?? "";
    // Started mid-file → the first element is a partial line, drop it.
    if (start > 0 && parts.length) parts.shift();
    this.push(parts);
    // The cursor sits at EOF; the trailing partial line is carried as `pending`
    // and completed by the next append (never re-read from the file).
    this.pending = rest;
    this.offset = size;
  }

  /** Complete lines appended since the previous poll. */
  poll(): string[] {
    const size = this.size(this.path);
    if (size < this.offset) { // truncated or rotated — restart from the top
      this.offset = 0;
      this.pending = "";
    }
    if (size <= this.offset) return [];
    const text = this.read(this.path, this.offset, size - this.offset);
    if (!text) return [];
    this.offset += Buffer.byteLength(text);
    const parts = (this.pending + text).split("\n");
    this.pending = parts.pop() ?? "";
    this.push(parts);
    return parts;
  }

  /** The buffered backlog (oldest first) replayed to a newly-connected client. */
  backlog(): string[] {
    return this.ring.slice();
  }

  private push(lines: string[]): void {
    for (const l of lines) this.ring.push(l);
    const over = this.ring.length - this.ringSize;
    if (over > 0) this.ring.splice(0, over);
  }
}
