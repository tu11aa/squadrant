// src/control/codex/app-server-client.ts
// Typed JSON-RPC 2.0 client for `codex app-server` v2.
// Transport: stdio (newline-delimited JSON). See spec §3.
// Defensive parser per orca codex-fetcher.ts:160-164: ignore non-JSON lines.

export function _parseChunk(acc: { buf: string }, chunk: string): unknown[] {
  acc.buf += chunk;
  const out: unknown[] = [];
  let idx: number;
  while ((idx = acc.buf.indexOf("\n")) >= 0) {
    const line = acc.buf.slice(0, idx);
    acc.buf = acc.buf.slice(idx + 1);
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip non-JSON defensively */ }
  }
  return out;
}
