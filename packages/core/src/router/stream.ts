// packages/core/src/router/stream.ts
import { Transform } from "node:stream";
import type { RouterUsage } from "./types.js";

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function absorb(evt: unknown, acc: RouterUsage): void {
  if (typeof evt !== "object" || evt === null) return;
  const e = evt as Record<string, unknown>;
  const message =
    typeof e.message === "object" && e.message !== null
      ? (e.message as Record<string, unknown>)
      : undefined;
  const usage = (e.usage ?? message?.usage) as Record<string, unknown> | undefined;
  if (usage) {
    acc.inputTokens = num(usage.input_tokens) ?? acc.inputTokens;
    acc.outputTokens = num(usage.output_tokens) ?? acc.outputTokens;
    acc.cacheReadTokens = num(usage.cache_read_input_tokens) ?? acc.cacheReadTokens;
    acc.cacheWriteTokens = num(usage.cache_creation_input_tokens) ?? acc.cacheWriteTokens;
    if (usage.cost !== undefined) acc.costUsd = num(usage.cost) ?? acc.costUsd;
  }
  if (e.cost !== undefined) acc.costUsd = num(e.cost) ?? acc.costUsd;
}

/** Pass-through Transform that scans SSE `data:` lines for usage/cost and calls
 *  onUsage once at flush. Bytes are never modified. */
export function createUsageTee(project: string, onUsage: (u: RouterUsage) => void): Transform {
  let buf = "";
  const acc: RouterUsage = { project };
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload && payload !== "[DONE]") {
            try {
              absorb(JSON.parse(payload), acc);
            } catch {
              /* non-JSON keep-alive */
            }
          }
        }
      }
      cb(null, chunk);
    },
    flush(cb) {
      try {
        onUsage(acc);
      } catch {
        /* best-effort */
      }
      cb();
    },
  });
}

/** Extract usage from a non-streaming response body. */
export function usageFromJson(project: string, body: Record<string, unknown>): RouterUsage {
  const acc: RouterUsage = { project };
  absorb({ usage: body.usage, cost: body.cost }, acc);
  return acc;
}
