import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { createUsageTee, usageFromJson } from "../stream.js";
import type { RouterUsage } from "../types.js";

function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

describe("createUsageTee", () => {
  it("passes bytes through unchanged and emits usage at flush", async () => {
    const seen: RouterUsage[] = [];
    const tee = createUsageTee("proj-a", (u) => seen.push(u));
    const src = Buffer.from(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7},"cost":"0.0012"}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    const out = await collect(Readable.from([src]).pipe(tee));
    expect(out.equals(src)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ project: "proj-a", inputTokens: 10, outputTokens: 7, costUsd: 0.0012 });
  });

  it("survives a chunk boundary mid-line", async () => {
    const seen: RouterUsage[] = [];
    const tee = createUsageTee("p", (u) => seen.push(u));
    const a = Buffer.from('data: {"type":"message_delta","usa');
    const b = Buffer.from('ge":{"output_tokens":3}}\n\n');
    await collect(Readable.from([a, b]).pipe(tee));
    expect(seen[0].outputTokens).toBe(3);
  });

  it("emits a trailing data: line with no terminating newline at flush", async () => {
    const seen: RouterUsage[] = [];
    const tee = createUsageTee("p", (u) => seen.push(u));
    const src = Buffer.from('data: {"usage":{"output_tokens":9}}');
    await collect(Readable.from([src]).pipe(tee));
    expect(seen).toHaveLength(1);
    expect(seen[0].outputTokens).toBe(9);
  });

  it("does not emit for a stream with no usage fields", async () => {
    const seen: RouterUsage[] = [];
    const tee = createUsageTee("p", (u) => seen.push(u));
    const src = Buffer.from('data: {"type":"message_start"}\n\ndata: {"type":"message_stop"}\n\n');
    await collect(Readable.from([src]).pipe(tee));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(0);
  });
});

describe("usageFromJson", () => {
  it("extracts usage + top-level string cost (opencode-go shape)", () => {
    const u = usageFromJson("p", {
      usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 100 },
      cost: "0.002",
    });
    expect(u).toMatchObject({ project: "p", inputTokens: 5, outputTokens: 6, cacheReadTokens: 100, costUsd: 0.002 });
  });

  it("returns undefined when the body has no usage fields", () => {
    expect(usageFromJson("p", { id: "msg_1" })).toBeUndefined();
  });
});
