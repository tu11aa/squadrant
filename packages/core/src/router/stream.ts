// packages/core/src/router/stream.ts
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { RouterUsage } from "./types.js";

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Merge any usage/cost fields from one event into `acc`. Returns true when at
 *  least one field was populated. */
function absorb(evt: unknown, acc: RouterUsage): boolean {
  if (typeof evt !== "object" || evt === null) return false;
  const e = evt as Record<string, unknown>;
  const message =
    typeof e.message === "object" && e.message !== null
      ? (e.message as Record<string, unknown>)
      : undefined;
  const usage = (e.usage ?? message?.usage) as Record<string, unknown> | undefined;
  let saw = false;
  if (usage) {
    const input = num(usage.input_tokens);
    if (input !== undefined) {
      acc.inputTokens = input;
      saw = true;
    }
    const output = num(usage.output_tokens);
    if (output !== undefined) {
      acc.outputTokens = output;
      saw = true;
    }
    const read = num(usage.cache_read_input_tokens);
    if (read !== undefined) {
      acc.cacheReadTokens = read;
      saw = true;
    }
    const write = num(usage.cache_creation_input_tokens);
    if (write !== undefined) {
      acc.cacheWriteTokens = write;
      saw = true;
    }
    if (usage.cost !== undefined) {
      const cost = num(usage.cost);
      if (cost !== undefined) {
        acc.costUsd = cost;
        saw = true;
      }
    }
  }
  if (e.cost !== undefined) {
    const cost = num(e.cost);
    if (cost !== undefined) {
      acc.costUsd = cost;
      saw = true;
    }
  }
  return saw;
}

/** Consume newline-terminated `data:` lines from `bufRef.value` into `acc`.
 *  Returns true when any usage field was populated. */
function scan(bufRef: { value: string }, acc: RouterUsage): boolean {
  let saw = false;
  let idx: number;
  while ((idx = bufRef.value.indexOf("\n")) !== -1) {
    const line = bufRef.value.slice(0, idx).trim();
    bufRef.value = bufRef.value.slice(idx + 1);
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          if (absorb(JSON.parse(payload), acc)) saw = true;
        } catch {
          /* non-JSON keep-alive */
        }
      }
    }
  }
  return saw;
}

/** Pass-through Transform that scans SSE `data:` lines for usage/cost and calls
 *  onUsage once at flush. Bytes are never modified. Emits only when at least one
 *  usage field was populated. */
export function createUsageTee(project: string, onUsage: (u: RouterUsage) => void): Transform {
  const buf = { value: "" };
  const acc: RouterUsage = { project };
  const decoder = new StringDecoder("utf8");
  let sawUsage = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buf.value += decoder.write(chunk);
      sawUsage = scan(buf, acc) || sawUsage;
      cb(null, chunk);
    },
    flush(cb) {
      buf.value += decoder.end();
      // Drain an unterminated final line (no trailing newline).
      if (buf.value.trim() !== "") {
        buf.value += "\n";
        sawUsage = scan(buf, acc) || sawUsage;
      }
      if (sawUsage) {
        try {
          onUsage(acc);
        } catch {
          /* best-effort */
        }
      }
      cb();
    },
  });
}

/** Extract usage from a non-streaming response body. Returns undefined when no
 *  usage field was populated. */
export function usageFromJson(
  project: string,
  body: Record<string, unknown>,
): RouterUsage | undefined {
  const acc: RouterUsage = { project };
  return absorb({ usage: body.usage, cost: body.cost }, acc) ? acc : undefined;
}
