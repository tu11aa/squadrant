import type { AgentFact } from "./fact.js";

export interface FactLogOptions {
  /** Facts retained per crew. Spec §6 default: 256. */
  capacity?: number;
}

/**
 * Flight recorder. Bounded in-memory history per crew; the facade dumps it to
 * disk only when something interesting happens (spec §6). Deliberately has no
 * fs dependency — the caller owns writing, this owns remembering.
 */
export class FactLog {
  private readonly capacity: number;
  private readonly buffers = new Map<string, AgentFact[]>();

  constructor(opts: FactLogOptions = {}) {
    this.capacity = opts.capacity ?? 256;
  }

  push(fact: AgentFact): void {
    let buf = this.buffers.get(fact.taskId);
    if (!buf) { buf = []; this.buffers.set(fact.taskId, buf); }
    buf.push(fact);
    // Ring semantics via shift: capacity is small (256) so the copy cost is
    // irrelevant next to the clarity of keeping a plain ordered array.
    while (buf.length > this.capacity) buf.shift();
  }

  /** Oldest-first snapshot. A fresh array; later pushes never grow it. */
  recent(taskId: string): AgentFact[] {
    return [...(this.buffers.get(taskId) ?? [])];
  }

  /** Newline-delimited JSON, one fact per line, oldest first. */
  serialize(taskId: string): string {
    return this.recent(taskId).map((f) => JSON.stringify(f)).join("\n") + "\n";
  }

  /** Release a finished crew's buffer. */
  drop(taskId: string): void {
    this.buffers.delete(taskId);
  }
}
