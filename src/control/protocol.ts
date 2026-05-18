// src/control/protocol.ts
import { createServer, createConnection, type Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";

export type Handler = (msg: any) => Promise<unknown>;

export function startServer(sockPath: string, handler: Handler): Server {
  if (existsSync(sockPath)) {
    try { unlinkSync(sockPath); } catch { /* stale socket */ }
  }
  const server = createServer((conn) => {
    const dec = createDecoder();
    conn.setEncoding("utf-8");
    conn.on("data", async (chunk: string) => {
      for (const msg of dec.push(chunk)) {
        try {
          const reply = await handler(msg);
          conn.write(encodeMsg({ ok: true, reply }));
        } catch (e) {
          conn.write(encodeMsg({ ok: false, error: String((e as Error).message ?? e) }));
        }
      }
    });
    conn.on("error", () => { /* client vanished; ignore */ });
  });
  server.listen(sockPath);
  return server;
}

export function sendRequest(sockPath: string, msg: unknown, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(sockPath);
    const dec = createDecoder();
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("control plane unavailable: request timed out"));
    }, timeoutMs);
    conn.setEncoding("utf-8");
    conn.on("connect", () => conn.write(encodeMsg(msg)));
    conn.on("data", (chunk: string) => {
      for (const m of dec.push(chunk) as any[]) {
        clearTimeout(timer);
        conn.end();
        if (m.ok) resolve(m.reply);
        else reject(new Error(m.error));
        return;
      }
    });
    conn.on("error", () => {
      clearTimeout(timer);
      reject(new Error("control plane unavailable: cannot reach cockpitd socket"));
    });
  });
}

export function encodeMsg(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

export function createDecoder() {
  let buf = "";
  return {
    push(chunk: string): unknown[] {
      buf += chunk;
      const out: unknown[] = [];
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      return out;
    },
  };
}
